// Replaces decode-uri-component (pulled in by react-admin through query-string 7) in the browser bundle.
// Versions up to 0.4.2 decode malformed %-sequences in exponential time (GHSA-vcc3-ghjq-m6fr): a crafted link could
// hang the tab. The native decoder is linear; input it cannot decode is returned as it is.
module.exports = function decodeUriComponent(value) {
  if (typeof value !== 'string') throw new TypeError(`Expected \`encodedURI\` to be of type \`string\`, got \`${typeof value}\``);
  try { return decodeURIComponent(value.replace(/\+/g, ' ')); } catch { return value; }
};
