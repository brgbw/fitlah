import unittest

from fitlah.integrations import strava_client


class StravaClientTest(unittest.TestCase):
    def test_interpolates_24km_time_from_longer_activity(self):
        streams = {
            "time": [0, 300, 600],
            "distance": [0, 1500, 3000],
        }

        self.assertEqual(
            strava_client.interpolate_time_at_distance(streams, 2400),
            480,
        )

    def test_process_ippt_24_uses_stream_time_not_full_activity_time(self):
        activity = {
            "id": "run-1",
            "name": "Longer Benchmark",
            "distance": 3000,
            "elapsed_time": 700,
            "moving_time": 600,
            "sport_type": "Run",
            "manual": False,
            "trainer": False,
            "average_speed": 5,
            "max_speed": 5.5,
        }
        streams = {
            "time": [0, 300, 480, 600],
            "distance": [0, 1500, 2400, 3000],
            "latlng": [[1.3, 103.8], [1.301, 103.801], [1.302, 103.802], [1.303, 103.803]],
            "velocity_smooth": [5, 5, 5, 5],
            "moving": [True, True, True, True],
        }

        result = strava_client.process_ippt_24(activity, streams)

        self.assertEqual(result["official_time_seconds"], 480)
        self.assertEqual(result["official_time"], "8:00")
        self.assertEqual(result["extra_distance_m"], 600)
        self.assertEqual(result["status"], "valid")

    def test_pacing_trend_flags_late_slowdown(self):
        splits = [
            {"time_seconds": 90},
            {"time_seconds": 180},
            {"time_seconds": 270},
            {"time_seconds": 370},
            {"time_seconds": 475},
            {"time_seconds": 585},
        ]

        self.assertEqual(strava_client.pacing_trend(splits), "slowed down")

    def test_build_activity_record_does_not_attach_hardcoded_ai_recommendation(self):
        activity = {
            "id": "run-2",
            "name": "Benchmark Run",
            "distance_km": 2.4,
            "score": "2.40 km",
            "time": "10:00",
            "date": "2026-06-06",
            "notes": "Imported from Strava.",
            "moving_time": 600,
            "elapsed_time": 610,
            "pace": "4:10/km",
            "start_date": "2026-06-06T00:00:00Z",
            "start_date_local": "2026-06-06T08:00:00Z",
        }

        record = strava_client.build_activity_record(activity, "S1234567A")

        self.assertNotIn("ai_recommendation", record)


if __name__ == "__main__":
    unittest.main()
