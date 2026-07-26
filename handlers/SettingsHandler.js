import { Settings } from "../database/models/Settings.js";

const defaults = {
    
};

const createDefaultSettings = async function () {
    for (const [key, value] of Object.entries(defaults)) {
        await Setting.findOrCreate({
            where: { key },
            defaults: { value }
        });
    }
}