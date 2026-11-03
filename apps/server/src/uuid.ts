/** A UUID in any version, as agents name their conversations (case-insensitive). */
export const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const UUID = new RegExp(`^${UUID_PATTERN}$`, "i");
