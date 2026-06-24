import path from 'path';

const BASE_DIR = process.cwd();

export const UPLOAD_FILE_PATH = path.join(BASE_DIR, '.blinkora/files')
export const DBBAKUP_PATH = path.join(BASE_DIR, '.blinkora/pgdump')
export const ROOT_PATH = path.join(BASE_DIR, '.blinkora')
export const EXPORT_BAKUP_PATH = path.join(BASE_DIR, 'backup')
export const TEMP_PATH = path.join(BASE_DIR, '.blinkora/files/temp')
