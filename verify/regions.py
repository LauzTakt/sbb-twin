# Regional subnetworks for the exact oracle (lat/lon boxes). Rail and EV trips are kept nationwide by the
# extractor; the oracle restricts its event graph to the stops inside one region (all modes there).
REGIONS = {
    # Olten - Aarau - Lenzburg/Brugg/Baden - Zürich HB corridor
    "olten-aarau-zurich": dict(lat=(47.33, 47.50), lon=(7.85, 8.56)),
    # Bern - Thun - Spiez - Interlaken West/Ost (EV1 Interlaken Ost <-> Rugenpark/West)
    "interlaken-spiez": dict(lat=(46.60, 46.96), lon=(7.40, 7.98)),
    # Lugano - Bellinzona - Cadenazzo - Locarno (EV Cadenazzo - Locarno)
    "ticino": dict(lat=(45.99, 46.25), lon=(8.74, 9.06)),
    # Zürich HB - Thalwil - Wädenswil - Pfäffikon SZ - Rapperswil
    "waedenswil-pfaeffikon": dict(lat=(47.15, 47.38), lon=(8.52, 8.85)),
}


def in_region(name, lat, lon):
    r = REGIONS[name]
    return r["lat"][0] <= lat <= r["lat"][1] and r["lon"][0] <= lon <= r["lon"][1]


def in_any_region(lat, lon):
    return any(in_region(n, lat, lon) for n in REGIONS)
