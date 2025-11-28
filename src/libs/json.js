// JSON serialization helpers
const serialize = (val) => JSON.stringify(val == null ? null : val);
const deserialize = (text, fallback) => {
    if (text == null) return fallback;
    try {
        return JSON.parse(text);
    } catch {
        return fallback;
    }
};

export { serialize, deserialize };