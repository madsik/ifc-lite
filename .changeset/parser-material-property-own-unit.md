---
"@ifc-lite/parser": patch
"@ifc-lite/ids": patch
---

A property in a material property set now reports its own `Unit` (#ISSUE). `extractMaterialPropertiesOnDemand` and `extractMaterialPropertiesForMaterialId` read `IfcMaterialProperties` and the IFC2X3 `IfcExtendedMaterialProperties`. Their entries now carry `unit`, `unitSiScale` and `unitSiOffset`, as the entries of `extractPropertiesOnDemand` already do. An entry gets these keys only when its property declares a `Unit`; other entries are unchanged.

- A unit the reader can resolve gives its symbol and scale, for example `mm` and `0.001`. A unit with an offset, such as a degree Fahrenheit, also gives `unitSiOffset`.
- A unit it cannot resolve gives the reference as `unit` (`#99`) and no scale. That covers a dangling reference and a unit of another kind than the value, such as an area unit on a length.
- The units are read from the source records. A store without source bytes reports no unit, as before.

IDS validation of a property facet on `IfcMaterial` follows. A value with its own unit is compared in SI, in that unit, not in the project unit. In a metre project, 200 with its own millimetre unit is 0.2, not 200. A value whose own unit cannot be resolved is no longer scaled by the project unit. A value without its own unit still takes the project unit.
