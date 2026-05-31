"""Best-effort NRIC age enrichment for user profiles."""

from .ippt_scoring import age_profile_from_nric
from .repositories import update_user


def enrich_age_fields(row):
    if not row:
        return row

    profile = age_profile_from_nric(row.get("nric"))
    if profile.get("age") is None:
        return row

    row.update(profile)
    return row


def sync_age_for_nric(nric):
    profile = age_profile_from_nric(nric)
    if profile.get("age") is None:
        return profile

    update_user(nric, profile)
    return profile
