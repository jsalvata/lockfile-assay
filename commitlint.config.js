export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'header-max-length': [2, 'always', 50],
    // Waivers ride in the commit body as a fenced ```waiver JSON block, and
    // pretty-printed JSON exceeds config-conventional's 100-char body limit.
    'body-max-line-length': [0],
  },
};
