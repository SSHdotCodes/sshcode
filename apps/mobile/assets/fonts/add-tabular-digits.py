"""Add tabular alternates without changing the source face’s default glyphs."""

from argparse import ArgumentParser
from pathlib import Path

from fontTools.otlLib.builder import buildLookup, buildSingleSubstSubtable
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables import otTables


def add_tabular_digits(source: Path, destination: Path) -> None:
    font = TTFont(source, recalcTimestamp=False)
    cmap = font.getBestCmap()
    metrics = font["hmtx"].metrics
    glyphs = font.getGlyphSet()
    order = list(font.getGlyphOrder())
    digits = [cmap[ord(digit)] for digit in "0123456789"]
    width = max(metrics[digit][0] for digit in digits)
    alternates = {}
    for digit in digits:
        alternate = f"{digit}.tnum"
        advance, bearing = metrics[digit]
        shift = (width - advance) // 2
        pen = TTGlyphPen(glyphs)
        pen.addComponent(digit, (1, 0, 0, 1, shift, 0))
        font["glyf"][alternate] = pen.glyph()
        metrics[alternate] = (width, bearing + shift)
        order.append(alternate)
        alternates[digit] = alternate
    font.setGlyphOrder(order)

    substitution = font["GSUB"].table
    lookups = substitution.LookupList
    lookup_index = len(lookups.Lookup)
    lookups.Lookup.append(buildLookup([buildSingleSubstSubtable(alternates)]))
    lookups.LookupCount = len(lookups.Lookup)

    features = substitution.FeatureList
    feature_index = next(
        (i for i, entry in enumerate(features.FeatureRecord) if entry.FeatureTag > "tnum"),
        len(features.FeatureRecord),
    )
    feature = otTables.FeatureRecord()
    feature.FeatureTag = "tnum"
    feature.Feature = otTables.Feature()
    feature.Feature.FeatureParams = None
    feature.Feature.LookupListIndex = [lookup_index]
    feature.Feature.LookupCount = 1
    features.FeatureRecord.insert(feature_index, feature)
    features.FeatureCount = len(features.FeatureRecord)

    for script_record in substitution.ScriptList.ScriptRecord:
        script = script_record.Script
        for language in [script.DefaultLangSys, *(r.LangSys for r in script.LangSysRecord)]:
            if language is None:
                continue
            if feature_index <= language.ReqFeatureIndex < 0xFFFF:
                language.ReqFeatureIndex += 1
            language.FeatureIndex = [
                *(i + (i >= feature_index) for i in language.FeatureIndex),
                feature_index,
            ]
            language.FeatureCount = len(language.FeatureIndex)

    font.save(destination)


if __name__ == "__main__":
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    add_tabular_digits(args.source, args.destination)
