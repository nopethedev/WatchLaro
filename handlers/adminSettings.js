import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
const file = path.resolve('database/admin-settings.json');
export const settingsSchema = z.object({ pauseQueue: z.boolean(), defaultQuality: z.enum(['720p', '1080p', '2160p']) });
const defaults = { pauseQueue: false, defaultQuality: '1080p' };
export function getAdminSettings() {
    try { return settingsSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8'))); }
    catch (err) { if (err.code === 'ENOENT') return { ...defaults }; throw err; }
}
export function saveAdminSettings(value) {
    const data = settingsSchema.parse(value);
    fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2));
    fs.renameSync(file + '.tmp', file);
    return data;
}
