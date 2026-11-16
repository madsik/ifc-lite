---
"@ifc-lite/ids": patch
---

`auditIDSDocument` no longer reports `E_IFC_ENTITY_IMPOSSIBLE` in IFC2X3 when one side of the pair is a name from the IDS occurrence/type mapping table and the other side names its occurrence class (#ISSUE). An applicability `IFCDISTRIBUTIONCONTROLELEMENT` with a requirement `IFCSENSOR`, or the other way round, is such a pair: the validator matches both names on a control element typed by an `IfcSensorType`, so the requirement can pass. An enumeration counts when one of its names forms such a pair.

- Two mapping names (`IFCSENSOR` and `IFCACTUATOR`), a class above the occurrence class (`IFCDISTRIBUTIONELEMENT`), and a mapping name of another occurrence class still report the error.
- IFC4 and IFC4X3 are unchanged. A specification for both IFC2X3 and IFC4 keeps the error for IFC4 only.
- The validator is unchanged.
