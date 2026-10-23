// Pure helper for the Settings page's "Add API key": the .env variable names of a
// service the catalogue does not know. Kept apart from agent_settings.js (which
// needs ComfyUI's app module) so it can be tested with plain node.
//
// MCP configs refer to these as ${MERCURY_API_KEY}, so the names are shown to the
// user under the fields. Returns null when no valid name comes of the input: it
// must start with a letter once uppercased and non-alphanumerics are made "_".

export function serviceEnvNames(name) {
  const prefix = String(name == null ? "" : name)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[A-Z]/.test(prefix)) return null;
  return { prefix, key: `${prefix}_API_KEY`, url: `${prefix}_BASE_URL` };
}
