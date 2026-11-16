---
"@ifc-lite/ids": patch
---

`auditIDSDocument` now reads a name from the IFC2X3 occurrence/type mapping table, such as `IFCSENSOR`, the way the validator does (#ISSUE). The validator matches such a name on an element of its occurrence class typed by the mapped type object: `IFCSENSOR` on an `IfcDistributionControlElement` typed by an `IfcSensorType`. The audit took the name as a class of its own, which IFC2X3 does not have, and reported errors on specifications the validator passes:

- `E_IFC_ENTITY_IMPOSSIBLE` for a mapping name on one side and its occurrence class on the other (applicability `IFCDISTRIBUTIONCONTROLELEMENT` with requirement `IFCSENSOR`, or the reverse). A pair now meets when both facets admit one element of a mapping row, decided as the validator decides it, for a simple value, an enumeration and a pattern (`IFCSENSOR.*`, `IFCSENSOR|IFCACTUATOR`).
- `E_IFC_PARTOF_ENTITY` for a classification, a material or a partOf on an applicability that is a mapping name. These are now checked against its occurrence class.
- `E_IFC_PROP_NOT_IN_PSET` for a property set of the occurrence class or of the mapped type object on such an applicability (`Pset_ManufacturerTypeInformation`, `Pset_SensorTypeTemperatureSensor`, `Pset_AirTerminalTypeCommon`). It is now checked against both.

These still report their errors: two mapping names of one occurrence class (`IFCSENSOR` and `IFCACTUATOR`), a class above the occurrence class (`IFCDISTRIBUTIONELEMENT`), a mapping name of another occurrence class, a partOf whose member must be an opening, and a property set of another class (`Pset_WallCommon`). IFC4 and IFC4X3 are unchanged, and a specification for both IFC2X3 and IFC4 keeps its IFC4 errors. The validator is unchanged.
