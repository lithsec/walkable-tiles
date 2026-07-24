# Data license — tile output

**The code in this repository is Apache-2.0 (see `LICENSE`). The _data_ it
produces is not, and cannot be — this file explains what governs the tiles.**

## Source

The walkable-way tiles this pipeline builds are extracted and derived from
**OpenStreetMap**:

> © OpenStreetMap contributors

OpenStreetMap's data is licensed under the **Open Database License (ODbL) 1.0**:
<https://opendatacommons.org/licenses/odbl/1-0/>

## What that means for the tiles

The tiles contain structured geodata (ways, street names, pedestrian crossings)
lifted directly from OSM. Under ODbL that makes each tile a **Derivative
Database**, not merely a rendered "Produced Work." Two obligations follow, and
neither is optional:

1. **Attribution.** Any product that displays or uses this data must visibly
   credit `© OpenStreetMap contributors`. In the app this appears on the
   coverage map and in Settings.

2. **Share-Alike.** Because the tiles are publicly distributed (served from a
   public CDN), the derived database is offered under **ODbL 1.0**. Anyone may
   use, copy, and adapt the tiles under the same license, and any publicly-used
   adaptation of the *database* must likewise be shared under ODbL.

## Scope — code vs. data

| Artifact | License |
|---|---|
| Pipeline source (this repo) | Apache-2.0 (`LICENSE`) |
| Tiles produced by the pipeline | ODbL 1.0, © OpenStreetMap contributors |

The Apache-2.0 grant on the code has no effect on the tile data. The permissive
code license and the copyleft data license coexist because they cover different
things.

## Attribution string (use verbatim)

Per OSM's attribution guidelines, keep this string as-is and untranslated:

> © OpenStreetMap contributors

For map surfaces that can show a longer credit:

> Map data © OpenStreetMap contributors, licensed under ODbL 1.0
