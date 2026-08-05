# SCORM 1.2 controlling documents

These four XML Schema documents come from Rustici Software's SCORM.com
"SCORM 1.2 Schema Definition" distribution:

https://scorm.com/wp-content/assets/SchemaDefinitionFiles/zips/scorm12schemadefinition.zip

Retrieved 2026-08-05. Line endings were normalized. The ADL content-packaging
schema and IMS content-packaging schema are otherwise unchanged. In
`ims_xml.xsd`, the historical, unused
default binding to `http://www.w3.org/XML/1998/namespace` was removed because
XML Namespaces reserves that namespace for the predefined `xml` prefix and
strict processors reject a default binding to it. This compatibility correction
does not alter any schema component or its target namespace.

In `imsmd_rootv1p2p1.xsd`, the extension wildcard is constrained from `##any`
to `##other`. The historical wildcard overlaps explicitly declared IMS
metadata elements and violates XML Schema's Unique Particle Attribution rule;
the corrected wildcard retains extensions from external namespaces.

The schemas implement the SCORM 1.2 content-packaging profile published by the
Advanced Distributed Learning (ADL) Initiative and the IMS Content Packaging
and Learning Resource Meta-data specifications. The corresponding IMS schemas
are also published by 1EdTech at:

https://www.imsglobal.org/xsd/index.html

The files remain controlling documents of their respective standards bodies;
vendoring them here makes generated packages self-contained and does not imply
project ownership of the schemas.

These documents are not covered by the repository's MIT license. See the root
`THIRD_PARTY_NOTICES.md` for the publication blocker created by the applicable
specification terms and these local compatibility changes.
