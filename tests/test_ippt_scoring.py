import unittest

from fitlah.domain.ippt_scoring import (
    calculate_ippt_score,
    normalize_gender,
    run_station_points,
    static_station_points,
)


class IpptScoringTest(unittest.TestCase):
    def test_male_scoring_remains_default(self):
        score = calculate_ippt_score(60, 60, "8:30", "22-24")

        self.assertEqual(score["gender"], "male")
        self.assertEqual(score["pushup_points"], 25)
        self.assertEqual(score["situp_points"], 25)
        self.assertEqual(score["run_points"], 50)
        self.assertEqual(score["total_points"], 100)

    def test_female_scoring_uses_station_specific_tables(self):
        self.assertEqual(static_station_points(48, "22-24", "female", "pushup"), 25)
        self.assertEqual(static_station_points(50, "22-24", "female", "situp"), 25)
        self.assertEqual(run_station_points(620, "22-24", "female"), 50)

        score = calculate_ippt_score(48, 50, "10:20", "22-24", "female")
        self.assertEqual(score["gender"], "female")
        self.assertEqual(score["total_points"], 100)

    def test_gender_normalization_accepts_common_labels(self):
        self.assertEqual(normalize_gender("Women"), "female")
        self.assertEqual(normalize_gender("F"), "female")
        self.assertEqual(normalize_gender("Men"), "male")
        self.assertEqual(normalize_gender(""), "male")


if __name__ == "__main__":
    unittest.main()
