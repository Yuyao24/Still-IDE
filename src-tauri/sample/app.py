"""Calculate the orbital period of a body around Earth."""

from dataclasses import dataclass
from math import pi, sqrt

EARTH_RADIUS_KM = 6_371
EARTH_MU = 398_600.4418


@dataclass(frozen=True)
class Orbit:
    name: str
    altitude_km: float

    @property
    def period_minutes(self) -> float:
        radius = EARTH_RADIUS_KM + self.altitude_km
        return 2 * pi * sqrt(radius**3 / EARTH_MU) / 60


def main() -> None:
    orbits = [
        Orbit("ISS", 408),
        Orbit("Hubble", 540),
    ]

    for orbit in orbits:
        print(f"{orbit.name:<10} {orbit.period_minutes:6.2f} min")


if __name__ == "__main__":
    main()
