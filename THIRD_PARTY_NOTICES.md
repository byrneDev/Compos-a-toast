# Third-party notices

The root [MIT license](LICENSE) applies only to original Compos-a-toast source code and
artwork for which contributors hold or have supplied the necessary rights. Third-party
packages, specifications, schemas, product names, and input course assets remain subject
to their own terms.

## JavaScript dependencies

Runtime and development dependencies are identified in `package.json` and the locked
dependency graph in `package-lock.json`. Their license metadata and notices remain with
the respective packages installed by npm.

## SCORM and IMS schema documents

The following vendored XML Schema documents are controlling documents associated with
SCORM 1.2, ADL, and IMS/1EdTech specifications and are not relicensed under MIT:

- `src/core/scorm/schemas/adlcp_rootv1p2.xsd`
- `src/core/scorm/schemas/imscp_rootv1p1p2.xsd`
- `src/core/scorm/schemas/imsmd_rootv1p2p1.xsd`
- `src/core/scorm/schemas/ims_xml.xsd`

Their sources and local compatibility changes are documented in
`src/core/scorm/schemas/ATTRIBUTION.md`. The standards owners retain their copyrights,
and their specification-license and attribution requirements continue to apply.

The 1EdTech Content Packaging specification license requires registration, attribution,
and preservation of its materials and restricts modification. Public redistribution of
the locally modified schema copies must therefore be reviewed and resolved before this
repository is published; the root MIT license alone does not authorize it.

## Product and organization names

Adobe, Adobe Captivate, Composica, SCORM, ADL, IMS, 1EdTech, Rustici Software, and other
names or marks mentioned by this project belong to their respective owners. Their use is
descriptive and does not imply sponsorship, certification, affiliation, or endorsement.
