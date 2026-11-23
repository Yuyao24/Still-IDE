import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from app import Orbit


class OrbitTests(unittest.TestCase):
    def test_iss_period(self):
        self.assertAlmostEqual(Orbit("ISS", 408).period_minutes, 92.58, places=2)


if __name__ == "__main__":
    unittest.main()
