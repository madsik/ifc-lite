---
"@ifc-lite/parser": patch
"@ifc-lite/ids": patch
---

A conversion-based unit whose `ConversionFactor` names another conversion-based unit, or a derived unit, as its `UnitComponent` is now resolved through that unit (#ISSUE), as the Rust resolver does since #3616. A foot of 12 inches, where the inch is 0.0254 m, is 0.3048 m. The JavaScript reader took the component at 1.0, so that foot was 12 m. This applies to `extractProjectUnits` and to every reader built on it. That covers the project units, a property's or quantity's own `Unit` (`unit`, `unitSiScale`, `unitSiOffset`) and the unit display. It also covers the IDS comparisons and the SI values the diff fingerprints compare.

- A chain resolves through every level: a yard of 3 such feet is 0.9144 m.
- A derived component counts with its own scale: 0.5 of dm³/s is 0.0005 m³/s, not 0.5.
- The same holds with a native reader (the 4th argument of `extractProjectUnits`). Such a unit used to be unresolved there, so a native project unit assignment that held one threw `ProjectUnitReadError`. It now resolves.
- An offset unit (`IfcConversionBasedUnitWithOffset`) over a conversion-based unit without an offset now resolves. An offset unit over a unit that has its own offset stays unresolved, as over a degree Celsius.
- A component the reader cannot resolve leaves the unit unresolved, where it used to give the bare factor. That covers a context-dependent unit, a unit whose own component dangles, and a cycle (a unit whose factor names itself, or two that name each other). A cycle now uses the walk's existing cycle guard. A length unit with a known name, such as `FOOT`, then falls back to its named factor on the parsed-source path, as it already did for a dangling component. A refused walk (a cycle, or a chain past 16 units) does not fall back.
- A component that is a monetary unit still counts as 1.0, as in Rust.

