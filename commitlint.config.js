export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'header-max-length': [2, 'always', 50],
    // waiver-stamp embeds pretty-printed waiver JSON in the commit body, whose
    // lines exceed config-conventional's 100-char default. Disable the rule so a
    // waivered commit is not rejected. (auto-approval-setup.md, step 6.)
    'body-max-line-length': [0],
  },
};
