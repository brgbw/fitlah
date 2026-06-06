import unittest

from fitlah.integrations import ai_coach


class AiCoachTest(unittest.TestCase):
    def test_compact_metrics_removes_raw_samples_and_preserves_rep_csv(self):
        metrics = {
            "exercise": "pushup",
            "valid_reps": 2,
            "movement_analysis": {
                "samples": [{"time": 0, "value": 1}, {"time": 1, "value": 2}],
                "reps": [
                    {"rep": 1, "amplitude_px": 24.1234, "period_s": 1.2},
                    {"rep": 2, "amplitude_px": 21.5, "period_s": 1.5},
                ],
                "stats": {"range": 30},
            },
        }

        compact = ai_coach._compact_metrics_for_prompt(metrics)

        self.assertIn("rep_metrics_csv", compact)
        self.assertIn("24.123", compact["rep_metrics_csv"])
        self.assertNotIn("samples", compact["movement_analysis"])
        self.assertNotIn("reps", compact["movement_analysis"])

    def test_parse_json_response_uses_current_coach_shape(self):
        parsed = ai_coach._parse_coach_json("""
        {
          "summary": "Hold **target pace**",
          "dos": ["Run **400m repeats**"],
          "donts": ["Speed dropped after **1600m**"],
          "focus_areas": ["Pacing", "Cadence"]
        }
        """)

        self.assertEqual(parsed["summary"], "Hold **target pace**")
        self.assertEqual(parsed["donts"], ["Speed dropped after **1600m**"])
        self.assertEqual(parsed["dos"], ["Run **400m repeats**"])
        self.assertEqual(parsed["focus_areas"], ["Pacing", "Cadence"])
        self.assertNotIn("safetyNote", parsed)

    def test_legacy_recommendation_fields_are_not_backfilled(self):
        parsed = ai_coach._parse_coach_json("""
        {
          "summary": "Hold **target pace**",
          "recommendations": ["Run **400m repeats**"],
          "safetyNote": "Warm up **8 minutes**"
        }
        """)

        self.assertEqual(parsed["summary"], "Hold **target pace**")
        self.assertEqual(parsed["dos"], [])
        self.assertEqual(parsed["donts"], [])
        self.assertEqual(parsed["focus_areas"], [])
        self.assertNotIn("recommendations", parsed)
        self.assertNotIn("safetyNote", parsed)


if __name__ == "__main__":
    unittest.main()
