---
"@ifc-lite/parser": patch
"@ifc-lite/ids": patch
"@ifc-lite/create": patch
"@ifc-lite/rules": patch
"@ifc-lite/mcp": patch
"@ifc-lite/cli": patch
---

A conversion-based unit whose `ConversionFactor` names another conversion-based unit, or a derived unit, as its `UnitComponent` is now resolved through that unit (#ISSUE), as the Rust resolver does since #3616. A foot of 12 inches, where the inch is 0.0254 m, is 0.3048 m. The JavaScript reader took the component at 1.0, so that foot was 12 m.

This applies to `extractProjectUnits`, on the parsed-source path and with a native reader (its 4th argument), and to a property's or quantity's own `Unit` read without a session view (`unit`, `unitSiScale`, `unitSiOffset`, `explicitUnitSiScale`). With a session view that component stays unresolved, as before: that walk has no depth cap or read budget.

- A chain resolves through every level: a yard of 3 such feet is 0.9144 m.
- A derived component counts with its own scale: 0.5 of dm³/s is 0.0005 m³/s, not 0.5.
- With a native reader such a unit used to be unresolved, so an assignment that held one threw `ProjectUnitReadError`. It now resolves, within the limit of 512 reads that `extractProjectUnits` puts on a native reader. A factor over a monetary unit, unresolved there before, now counts the monetary unit as 1.0, as the parsed-source path and Rust already did.
- An offset unit (`IfcConversionBasedUnitWithOffset`) over a conversion-based unit without an offset now resolves. An offset unit over a unit that has its own offset stays unresolved, as over a degree Celsius.
- A component the reader cannot resolve leaves the unit unresolved, where it used to give the bare factor: a context-dependent unit, a unit whose own component dangles, and a cycle (a unit whose factor names itself, or two that name each other). A length unit with a known name, such as `FOOT`, then falls back to its named factor on the parsed-source path, as it already did for a dangling component. A refused walk (a cycle, or a chain past 16 units) does not fall back.

What follows in the packages that read these units. Each now gets the resolved scale. Where a component cannot be resolved, each takes the fallback it already takes for a dangling component, where it used the bare factor: an SI default, the length unit squared or cubed, no factor, or, in `projectMeasureScales`, its "Cannot resolve the project's ... unit" error.

- `@ifc-lite/ids`: the SI comparison of a value in its own unit, and of a value in a project unit other than length. The project length unit is read through `extractLengthUnitScale`, which this does not change.
- `@ifc-lite/create`: the project area and volume scales of the base quantities it writes, the wall height quantities, and the area, volume and plane angle scales of `projectMeasureScales`.
- `@ifc-lite/rules`: `projectSiScale` and `quantityValueSiScale` in the measure filters.
- `@ifc-lite/mcp`: the geometry tool's unit symbols. An unresolved unit shows the SI default symbol, as an undeclared one does.
- `@ifc-lite/mcp` and `@ifc-lite/cli`: the diff fingerprints hash these SI values, so a model with such a unit fingerprints differently.
