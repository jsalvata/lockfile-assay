export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always', ['feat', 'fix', 'docs']],
    'header-max-length': [2, 'always', 50],
  },
};
