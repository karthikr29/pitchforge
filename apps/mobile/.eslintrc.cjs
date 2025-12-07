module.exports = {
  root: true,
  extends: ["universe/native", "plugin:react-hooks/recommended"],
  ignorePatterns: ["node_modules/", "dist/"],
  rules: {
    "react/react-in-jsx-scope": "off",
    "import/no-default-export": "off",
    "@typescript-eslint/no-explicit-any": "warn"
  }
};

