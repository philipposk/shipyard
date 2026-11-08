# apply-design.mjs facts

- Options: `--preset`, `--tokens`, `--source preset|screenshot|url|design-md|custom`, `--fix`, `--dry-run`, `--set-default`, `--keep-layout`, `--languages`, `--no-icons`, `--json`. Running it twice gives the same result.
- If it says the colour markers are missing, run `which-app.mjs` again. `general`: do not use this script; write the chosen look into the app's own styles, light and dark. `shipyard`: the template markers are missing, so do not hand-edit between the markers; explain it.
- Never edit between the `shipyard:tokens` markers in `globals.css` by hand. Always go through the script.
- Wanting one colour changed: copy `.shipyard/design/applied.tokens.json`, change it, apply with `--tokens ... --fix`.
- Apps made before this version lack the size and spacing block. They still get the new colours, with a note that sizes were skipped.
