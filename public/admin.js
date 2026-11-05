async function adminRequest(url, method = 'GET', body) {
    const response = await fetch(url, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json().catch(() => ({ error: 'The server returned an unexpected response. Please sign in again.' }));
    if (!response.ok) throw new Error(data.error || 'Request failed');
    return data;
}
function adminMedia() {
    return {
        files: [], query: '', type: '', status: '', page: 1, pages: 1, total: 0, loading: true, error: '', message: '', busy: '', timer: null, editing: null, edit: {}, fetching: false, art: {}, artBusy: false,
        async init() { const params=new URLSearchParams(location.search);this.status=params.get('status') || '';await this.load(); this.timer = setInterval(() => this.load(false), 4000); },
        destroy() { clearInterval(this.timer); },
        async load(show = true) {
            if (this.fetching) return;
            this.fetching = true; if (show) this.loading = true;
            try { const data = await adminRequest('/api/admin/files?' + new URLSearchParams({q:this.query,type:this.type,status:this.status,page:this.page})); Object.assign(this, {files:data.files,total:data.total,pages:data.pages,error:''}); void this.loadArtwork(); }
            catch(e) { this.error=e.message; } finally { this.loading=false; this.fetching=false; }
        },
        async filter() { this.page=1; await this.load(); },
        async go(step) { this.page += step; await this.load(); },
        percent(file) { return file.status === 'done' ? 100 : Math.max(0, Math.min(100, Number(file.progress) || 0)); },
        label(file) { return file.queued && file.status === 'downloading' ? 'Queued' : file.status; },
        artworkUrl(file) { const key = file.type + ':' + file.linkedId; const path = key in this.art ? this.art[key] : ''; return path ? 'https://image.tmdb.org/t/p/w780' + path : ''; },
        artBackground(file) { const url = this.artworkUrl(file); return url ? `background-image:url('${url}');` : ''; },
        revealStyle(file) { const pct = this.percent(file); return `clip-path:inset(0 ${100 - pct}% 0 0);-webkit-clip-path:inset(0 ${100 - pct}% 0 0);`; },
        async loadArtwork() {
            if (this.artBusy) return;
            const missing = [...new Map(this.files.filter(f => f.linkedId && !((f.type + ':' + f.linkedId) in this.art)).map(f => [f.type + ':' + f.linkedId, f])).values()];
            if (!missing.length) return;
            this.artBusy = true;
            try {
                await Promise.all(missing.map(async file => {
                    const key = file.type + ':' + file.linkedId;
                    try {
                        const info = await adminRequest(file.type === 'tv' ? '/api/tv/info' : '/api/movies/info', 'POST', { q: file.linkedId });
                        this.art[key] = info.backdrop_path || info.poster_path || '';
                    } catch { this.art[key] = ''; }
                }));
            } finally { this.artBusy = false; }
        },
        async action(file, action, method = 'POST') {
            if (this.busy) return;
            if (action === 'delete' && !confirm(`Permanently delete “${file.name}” and its downloaded files?`)) return;
            if (action === 'skip' && !confirm('Convert incomplete data? This may produce an unplayable file.')) return;
            this.busy=file.uuid; this.error=''; this.message='';
            try {
                const url='/api/admin/files/'+file.uuid+(action==='delete'?'':'/'+action);
                const result=await adminRequest(url, action==='delete'?'DELETE':method);
                if (action==='share' && method==='POST') { this.$refs.shareValue.value=result.url; this.$refs.shareDialog.showModal(); }
                else this.message = action==='delete'?'Media deleted.':'Changes saved.';
                await this.load(false);
            } catch(e) { this.error=e.message; } finally { this.busy=''; }
        },
        openEdit(file) { this.editing=file.uuid; this.edit={name:file.name,quality:file.quality,linkedId:file.linkedId,type:file.type,season:file.season,episode:file.episode}; this.$refs.editDialog.showModal(); },
        async saveEdit() {
            this.busy=this.editing; this.error='';
            try { await adminRequest('/api/admin/files/'+this.editing,'PATCH',{...this.edit,season:this.edit.type==='tv'?Number(this.edit.season):null,episode:this.edit.type==='tv'?Number(this.edit.episode):null}); this.$refs.editDialog.close();this.message='Media details updated.';await this.load(false); }
            catch(e) { this.error=e.message; } finally { this.busy=''; }
        },
        async copyShare() { try { await navigator.clipboard.writeText(this.$refs.shareValue.value);this.message='Share link copied.'; } catch { this.message='Select and copy the link from the dialog.'; } }
    };
}
function adminUsers() {
    return {
        users:[],query:'',rankFilter:'',page:1,pages:1,total:0,loading:true,error:'',message:'',busy:'',
        async init() { await this.load(); if(new URLSearchParams(location.search).has('saved')) this.message='User saved successfully.'; },
        async load() { this.loading=true;try { const data=await adminRequest('/api/admin/users?'+new URLSearchParams({q:this.query,rank:this.rankFilter,page:this.page}));Object.assign(this,{users:data.users,pages:data.pages,total:data.total,error:''}); } catch(e){this.error=e.message;}finally{this.loading=false;} },
        async filter() { this.page=1;await this.load(); },
        async go(step) { this.page+=step;await this.load(); },
        async remove(user) { if(!confirm('Permanently delete '+user.username+'? They will lose access.'))return;this.busy=user.uuid;try{await adminRequest('/api/admin/users/'+user.uuid,'DELETE');this.message='User deleted.';await this.load();}catch(e){this.error=e.message;}finally{this.busy='';} }
    };
}
function adminUserForm(uuid) {
    return {
        uuid, loading:Boolean(uuid),saving:false,error:'',form:{username:'',email:'',password:'',rank:'member',bio:'',profilePicture:''},
        async init() { if(!this.uuid)return;try{const data=await adminRequest('/api/admin/users/info/'+this.uuid);for(const key of Object.keys(this.form))if(key!=='password')this.form[key]=data[key] || (key==='rank'?'member':'');if(this.form.rank==='user')this.form.rank='member';}catch(e){this.error=e.message;}finally{this.loading=false;} },
        async save() { this.saving=true;this.error='';try{await adminRequest('/api/admin/users/'+(this.uuid?'edit/'+this.uuid:'create'),'POST',this.form);location.href='/admin/users?saved=1';}catch(e){this.error=e.message;}finally{this.saving=false;} }
    };
}
function adminSettings(initial) {
    return { form:initial,busy:false,error:'',message:'',async save(){this.busy=true;this.error='';this.message='';try{await adminRequest('/api/admin/settings','POST',this.form);this.message='Settings saved. New jobs use the updated preferences.';}catch(e){this.error=e.message;}finally{this.busy=false;}} };
}

function downloadForm(defaultQuality = "1080p") {
 return {
 type:'movie', query:'', results:[], selected:null, seasons:[], season:1, episodes:[], checked:[], torrents:[], torrentQuery:'', episode:null, quality:defaultQuality, busy:false, message:'',
 async request(url, body) { const r = await fetch(url, body === undefined ? {} : { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }); const data = await r.json(); if(!r.ok) throw new Error(data.error || 'Request failed'); return data; },
 async work(fn) { this.busy=true; this.message=''; try { await fn(); } catch(e) { this.message=e.message; } finally { this.busy=false; } },
 reset() { this.results=[]; this.selected=null; this.torrents=[]; this.checked=[]; this.episode=null; },
 async search() { await this.work(async()=> { this.reset(); this.results=await this.request('/api/admin/'+this.type+'/search?q='+encodeURIComponent(this.query)); }); },
 async choose(item) { await this.work(async()=> { this.selected=item; this.results=[]; this.torrents=[]; if(this.type==='tv') { const info=await this.request('/api/tv/info',{q:item.id}); this.seasons=info.seasons || []; this.season=this.seasons.find(s=>s.season_number>0)?.season_number ?? 0; await this.fetchSeason(); } }); },
 aired(ep) { return ep.air_date && ep.air_date <= new Date().toISOString().slice(0,10); },
 async fetchSeason() { const info=await this.request('/api/tv/season/info',{q:this.selected.id,season:this.season}); this.episodes=info.episodes || []; this.checked=[]; this.torrents=[]; this.episode=null; },
 async loadSeason() { await this.work(()=>this.fetchSeason()); },
 tag(s,e) { return 'S'+String(s).padStart(2,'0')+'E'+String(e).padStart(2,'0'); },
 async findTorrent(ep) { this.episode=ep; this.torrentQuery=(this.selected.title || this.selected.name)+(ep===null ? ' '+(this.selected.release_date || '').slice(0,4) : ' '+this.tag(this.season,ep)+(this.type==='tv' ? ' '+this.quality : '')); await this.searchTorrents(); },
 async searchTorrents() { await this.work(async()=>{ this.torrents=await this.request('/api/admin/torrent/search?q='+encodeURIComponent(this.torrentQuery)); }); },
 payload(magnet,s=this.season,e=this.episode) { return {magnet,tmdbId:this.selected.id,type:this.type,season:this.type==='tv'?Number(s):null,episode:this.type==='tv'?Number(e):null,quality:this.quality}; },
 async download(torrent) { await this.work(async()=> { if(this.type==='tv' && this.episode===null) throw new Error('Choose an episode first'); const result=await this.request('/api/admin/torrent/create',this.payload(torrent.magnet)); this.message=result.skipped?'Already in library or download queue.':'Download queued. View progress under Media.'; }); },
 async bulk(all) { await this.work(async()=> {
 const targets=[];
 if(all) { for(const s of this.seasons.filter(s=>s.season_number>0)) { const info=await this.request('/api/tv/season/info',{q:this.selected.id,season:s.season_number}); for(const ep of info.episodes || []) if(this.aired(ep)) targets.push([s.season_number,ep.episode_number]); } }
 else for(const e of this.checked) targets.push([Number(this.season),Number(e)]);
 if(!targets.length) throw new Error('No aired episodes selected');
 if(!confirm('Find and queue '+targets.length+' episodes?')) return;
 let added=0, skipped=0; const missing=[];
 for(const [s,e] of targets) {
 this.message='Finding '+this.tag(s,e)+'…';
 try {
 const matches=await this.request('/api/admin/torrent/search?q='+encodeURIComponent(this.selected.name+' '+this.tag(s,e)+' '+this.quality));
 const pattern=new RegExp('(?:s0*'+s+'e0*'+e+'(?![0-9])|\\b0*'+s+'x0*'+e+'(?![0-9]))','i');
 const pick=matches.filter(t=>t.magnet?.startsWith('magnet:') && pattern.test(t.title) && t.title.toLowerCase().includes(this.quality.toLowerCase())).sort((a,b)=>b.seeds-a.seeds)[0];
 if(!pick) { missing.push(this.tag(s,e)); continue; }
 const r=await this.request('/api/admin/torrent/bulk',{items:[this.payload(pick.magnet,s,e)]}); added+=r.added; skipped+=r.skipped;
 } catch(err) { missing.push(this.tag(s,e)+': '+err.message); }
 }
 this.message=added+' queued, '+skipped+' already present.'+(missing.length?' Unavailable/failed: '+missing.join(', '):'');
 }); }
 };
}
