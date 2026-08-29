# WatchLaro

A self-hostable alternative to Jellyfin, built around downloading and sharing media instead of just streaming from a static library. Written in EJS and Javascript using MariaDB as database.

> ⚠️ **Alpha Software**
> WatchLaro is in early alpha. Most planned features are **not implemented yet** — only the bare essentials currently work. Expect bugs, missing functionality, and breaking changes between updates. Not recommended for production use yet.

## What Works Right Now

- Core download pipeline
- Basic media playback
- Minimal frontend for browsing what's already downloaded
- Share movies directly from the admin panel.

Everything else below is planned but not yet available.

## Roadmap

Planned features, roughly in the order we're tackling them:

- [ ] **Proper browsing** — real library browsing with search, filters, and sorting
- [ ] **TV show support** — seasons, episodes, and series tracking
- [ ] **Proper sharing** — real sharing system instead of the current bare-bones approach
- [ ] **Movie requests** — let users request titles to be downloaded
- [ ] **Subtitles** — subtitle search, download, and syncing
- [ ] **Dubs** — support for dubbed audio tracks
- [ ] **On-demand streaming** — stream directly without requiring a full download first

## System Requirements

- **OS:** Any system that supports Node 22+
- **CPU:** 1 core or more
- **RAM:** 1 GB or more
- **Storage:** 5 GB SSD minimum (20+ GB free recommended)
- **Database:** MariaDB required (SQLite support coming soon)
- **GPU transcoding:** not supported yet (CPU-only for now)

## Installation

1. **Clone the repo**
    Or you can just download the latest release.
   ```bash
   git clone https://github.com/<your-username>/watchlaro.git
   cd watchlaro
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment**
   Copy the example env file and edit it with your settings:
   ```bash
   cp .env.example .env
   nano .env
   ```

4. **Start the server**
   ```bash
   npm start
   ```

WatchLaro should now be running — check your terminal output for the address and port.

## Contributing

WatchLaro is early and evolving fast. Issues, ideas, and PRs are welcome, but expect the codebase to shift as core features land.

## License

Licensed under [AGPLv3](https://www.gnu.org/licenses/agpl-3.0.html). This ensures that any modified versions of WatchLaro run as a public service must also share their source code.