#!/usr/bin/env python3
"""Build a deterministic, strict contact import bundle.

Inputs are read-only. Output JSONL is sorted, gzip-compressed with mtime=0,
and validated by a second pass before checksums are written.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
import shutil
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from openpyxl import load_workbook


APPROVED_WORKBOOK_SHA256 = "99618834a0664ff63af63e757eb1537076799e8109a076da3696e58875be5510"

EMAIL_RE = re.compile(r"^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$", re.I)
NAME_TOKEN_RE = re.compile(r"[^\W\d_]+(?:[-'][^\W\d_]+)*", re.UNICODE)
CONSUMER_DOMAINS = frozenset(
    {
        "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "rocketmail.com",
        "hotmail.com", "outlook.com", "live.com", "msn.com", "icloud.com", "me.com",
        "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com",
        "gmx.net", "mail.com", "zoho.com", "fastmail.com", "hey.com", "tutanota.com",
        "tuta.com", "comcast.net", "sbcglobal.net", "att.net", "bellsouth.net",
        "charter.net", "cox.net", "spectrum.net", "verizon.net", "earthlink.net",
    }
)
GENERIC_NAME_TOKENS = frozenset(
    {
        "contact", "directory", "faculty", "staff", "school", "campus", "office",
        "information", "info", "webmaster", "administrator", "administration",
        "department", "team", "teacher", "teachers", "counseling", "principal",
        "secretary", "attendance", "registrar", "reception", "support", "helpdesk",
        "communications", "transportation", "nutrition", "human", "resources",
        "assistant", "image", "logo",
    }
)
BAD_SOURCE_MARKERS = (
    "/api/", "/api?", "/api.", "/graphql", "/ajax/", "/endpoint/",
)
INFERENCE_MARKERS = ("infer", "guess", "pattern", "predicted", "generated", "enrich")
PUBLISHED_EVIDENCE_RE = re.compile(
    r"^(?:published|rendered|decoded|publicly displayed|public campus directory entry)\b",
    re.I,
)

ACCEPTED_FIELDS = (
    "record_id", "district", "school", "directory_url", "full_name", "title",
    "department", "email", "email_source", "collected_at_utc",
    "organization_website_published", "location_published", "city_published",
    "county_published", "state_published", "grade_range_published",
    "canonical_source_row", "canonical_campus_key", "qa_identity_method", "source_dataset",
)


def text(value) -> str:
    return "" if value is None else re.sub(r"\s+", " ", str(value)).strip()


def exact_key(value) -> str:
    return text(unicodedata.normalize("NFKC", text(value))).casefold()


def campus_alias_key(value) -> str:
    """Controlled TEA-name normalization, not fuzzy matching."""
    value = exact_key(value)
    value = value.replace("&", " and ")
    value = re.sub(r"[^\w]+", " ", value, flags=re.UNICODE)
    value = f" {re.sub(r'\s+', ' ', value).strip()} "
    replacements = (
        (r"\bjunior high school\b|\bjunior high\b|\bj h\b|\bjh\b", " junior_high "),
        (r"\bhigh school\b|\bh s\b|\bhs\b", " high_school "),
        (r"\belementary school\b|\belementary\b|\belem\b|\bel\b", " elementary "),
        (r"\bmiddle school\b|\bmiddle\b|\bm s\b|\bms\b", " middle_school "),
        (r"\bintermediate school\b|\bintermediate\b|\bint\b", " intermediate "),
    )
    for pattern, replacement in replacements:
        value = re.sub(pattern, replacement, value)
    return re.sub(r"\s+", " ", value).strip()


def email_key(value) -> str:
    return text(value).lower()


def clean_url(value) -> str:
    return text(value)


def human_url_reason(value: str) -> str | None:
    if not value:
        return "missing_human_source_url"
    try:
        u = urlsplit(value)
    except ValueError:
        return "invalid_human_source_url"
    if u.scheme.lower() not in {"http", "https"} or not u.hostname:
        return "invalid_human_source_url"
    lower = value.lower()
    host = (u.hostname or "").lower()
    if host == "api" or host.startswith("api.") or ".api." in host:
        return "api_or_machine_source_url"
    if any(marker in lower for marker in BAD_SOURCE_MARKERS):
        return "api_or_machine_source_url"
    if u.path.lower().endswith((".json", ".xml")):
        return "api_or_machine_source_url"
    return None


def name_tokens(value: str) -> list[str]:
    return NAME_TOKEN_RE.findall(value)


def name_reason(value: str) -> str | None:
    tokens = name_tokens(value)
    if len(tokens) < 2:
        return "person_name_fewer_than_two_words"
    if len(tokens) > 6 or any(marker in value for marker in ("@", "|", ":")):
        return "malformed_person_name"
    folded = {t.casefold() for t in tokens}
    if folded <= GENERIC_NAME_TOKENS or not (folded - GENERIC_NAME_TOKENS):
        return "generic_person_name"
    if any(ch.isdigit() for ch in value):
        return "malformed_person_name"
    return None


def email_reason(value: str) -> str | None:
    e = email_key(value)
    if not EMAIL_RE.fullmatch(e):
        return "invalid_email"
    domain = e.rsplit("@", 1)[1]
    if domain in CONSUMER_DOMAINS:
        return "consumer_email_domain"
    return None


def load_campuses(workbook: Path):
    wb = load_workbook(workbook, read_only=True, data_only=True)
    ws = wb["TX School Websites"]
    headers = [text(v) for v in next(ws.iter_rows(min_row=1, max_row=1, values_only=True))]
    by_pair = defaultdict(list)
    by_alias_pair = defaultdict(list)
    by_row = {}
    for row_num, values in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
        src = dict(zip(headers, values))
        campus = {
            "canonical_source_row": row_num,
            "county": text(src.get("County")),
            "district": text(src.get("District")),
            "district_website": text(src.get("District Website")),
            "school": text(src.get("School")),
            "city": text(src.get("City")),
            "grade_range": text(src.get("Grade Range")),
            "school_website": text(src.get("School Website (End URL)")),
            "website_source": text(src.get("Website Source")),
            "status": text(src.get("Status")),
        }
        pair = (exact_key(campus["district"]), exact_key(campus["school"]))
        alias_pair = (exact_key(campus["district"]), campus_alias_key(campus["school"]))
        by_pair[pair].append(campus)
        by_alias_pair[alias_pair].append(campus)
        by_row[row_num] = campus
    wb.close()
    return by_pair, by_alias_pair, by_row


def match_campus(record, by_pair, by_alias_pair, by_row):
    pair = (exact_key(record.get("district")), exact_key(record.get("school")))
    claimed = record.get("_canonical_source_row")
    if claimed not in (None, ""):
        try:
            campus = by_row[int(claimed)]
        except (KeyError, TypeError, ValueError):
            return None, "invalid_canonical_source_row", None
        actual = (exact_key(campus["district"]), exact_key(campus["school"]))
        if actual != pair:
            return None, "canonical_row_district_school_mismatch", None
        return campus, None, "claimed_canonical_workbook_row"
    matches = by_pair.get(pair, [])
    if not matches:
        alias_pair = (exact_key(record.get("district")), campus_alias_key(record.get("school")))
        alias_matches = by_alias_pair.get(alias_pair, [])
        if len(alias_matches) == 1:
            return alias_matches[0], None, "unique_controlled_tea_name_alias"
        if len(alias_matches) > 1:
            return None, "ambiguous_controlled_tea_name_alias", None
        return None, "no_unique_workbook_campus_match_after_controlled_aliases", None
    if len(matches) != 1:
        return None, "ambiguous_exact_workbook_campus_match", None
    return matches[0], None, "exact_workbook_district_school"


def canonical_record(record, campus, dataset, mapping_method):
    full_name = text(record.get("full_name"))
    email = email_key(record.get("email"))
    campus_key = f'{campus["district"]}|{campus["school"]}|{campus["canonical_source_row"]}'
    dedupe_key = f'{exact_key(campus["district"])}|{exact_key(campus["school"])}|{email}'
    record_id = hashlib.sha256(dedupe_key.encode("utf-8")).hexdigest()[:24]
    result = {
        "record_id": record_id,
        "district": campus["district"],
        "school": campus["school"],
        "directory_url": clean_url(record.get("directory_url")),
        "full_name": full_name,
        "title": text(record.get("title")),
        "department": text(record.get("department")),
        "email": email,
        "email_source": text(record.get("email_source")),
        "collected_at_utc": text(record.get("collected_at_utc")),
        "organization_website_published": campus["school_website"],
        "location_published": campus["school"],
        "city_published": campus["city"],
        "county_published": campus["county"],
        "state_published": "Texas",
        "grade_range_published": campus["grade_range"],
        "canonical_source_row": campus["canonical_source_row"],
        "canonical_campus_key": campus_key,
        "qa_identity_method": text(record.get("_qa_identity_method")) or mapping_method,
        "source_dataset": dataset,
    }
    return result, dedupe_key


def json_bytes(obj) -> bytes:
    return (json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def write_gzip(path: Path, rows):
    with path.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=9) as gz:
            for row in rows:
                gz.write(json_bytes(row))


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def normalized_domain(value: str) -> str:
    try:
        host = (urlsplit(value).hostname or "").lower().rstrip(".")
    except ValueError:
        return ""
    return host[4:] if host.startswith("www.") else host


def approved_domains_from_workbook(by_row) -> list[str]:
    domains = {
        normalized_domain(url)
        for campus in by_row.values()
        for url in (campus["district_website"], campus["school_website"])
        if normalized_domain(url)
    }
    return sorted(domains)


def source_is_approved(value: str, approved_domains: set[str]) -> bool:
    host = normalized_domain(value)
    return bool(host) and any(host == domain or host.endswith(f".{domain}") for domain in approved_domains)


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workbook", required=True, type=Path)
    parser.add_argument("--batch1", required=True, type=Path)
    parser.add_argument("--batch2", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--artifact-created-at",
        required=True,
        help="Truthful ISO-8601 time when this artifact is created; use the same value for reproducible rebuilds",
    )
    return parser.parse_args()


def canonical_utc_timestamp(value: str, label: str) -> str:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise SystemExit(f"{label} must be an ISO-8601 timestamp: {value}") from exc
    if parsed.tzinfo is None:
        raise SystemExit(f"{label} must include a UTC offset: {value}")
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def main():
    args = parse_args()
    workbook = args.workbook.resolve()
    output = args.output.resolve()
    artifact_created_at = canonical_utc_timestamp(
        args.artifact_created_at, "--artifact-created-at"
    )
    inputs = (("batch1", args.batch1.resolve()), ("batch2", args.batch2.resolve()))
    for path in (workbook, *(path for _, path in inputs)):
        if not path.is_file():
            raise SystemExit(f"input does not exist: {path}")
    workbook_sha256 = sha256(workbook)
    if workbook_sha256 != APPROVED_WORKBOOK_SHA256:
        raise SystemExit(
            f"workbook SHA256 is not the approved Texas roster: {workbook_sha256}"
        )

    output.mkdir(parents=True, exist_ok=True)
    by_pair, by_alias_pair, by_row = load_campuses(workbook)
    approved_domains = approved_domains_from_workbook(by_row)
    approved_domain_set = set(approved_domains)
    accepted = []
    quarantine = []
    reject_counts = Counter()
    reject_counts_by_dataset = defaultdict(Counter)
    input_counts = Counter()
    accepted_counts = Counter()
    quarantine_counts = Counter()
    mapping_method_counts = Counter()
    campus_match_counts_all = Counter()
    unresolved_campus_counts = Counter()
    malformed = Counter()
    seen = set()

    for dataset, path in inputs:
        with path.open("r", encoding="utf-8") as fh:
            for source_line, line in enumerate(fh, start=1):
                input_counts[dataset] += 1
                try:
                    record = json.loads(line)
                except json.JSONDecodeError as exc:
                    reason = "malformed_json_line"
                    malformed[dataset] += 1
                    reject_counts[reason] += 1
                    reject_counts_by_dataset[dataset][reason] += 1
                    quarantine_counts[dataset] += 1
                    quarantine.append({
                        "source_dataset": dataset,
                        "source_file": path.name,
                        "source_line": source_line,
                        "rejection_reasons": [reason],
                        "parse_error": str(exc),
                        "raw_line_sha256": hashlib.sha256(line.encode("utf-8")).hexdigest(),
                    })
                    continue

                reasons = []
                campus, campus_reason, mapping_method = match_campus(record, by_pair, by_alias_pair, by_row)
                if campus_reason:
                    reasons.append(campus_reason)
                    unresolved_campus_counts[(text(record.get("district")), text(record.get("school")))] += 1
                else:
                    campus_match_counts_all[mapping_method] += 1
                for reason in (
                    name_reason(text(record.get("full_name"))),
                    email_reason(text(record.get("email"))),
                    human_url_reason(clean_url(record.get("directory_url"))),
                ):
                    if reason:
                        reasons.append(reason)
                if not source_is_approved(clean_url(record.get("directory_url")), approved_domain_set):
                    reasons.append("source_domain_outside_approved_workbook_scope")
                evidence = text(record.get("email_source")).casefold()
                if not evidence:
                    reasons.append("missing_publication_evidence")
                elif any(marker in evidence for marker in INFERENCE_MARKERS):
                    reasons.append("inferred_or_generated_email")
                elif PUBLISHED_EVIDENCE_RE.match(evidence) is None:
                    reasons.append("email_source_lacks_positive_publication_evidence")

                canonical = dedupe_key = None
                if campus is not None:
                    canonical, dedupe_key = canonical_record(record, campus, dataset, mapping_method)
                    if dedupe_key in seen:
                        reasons.append("duplicate_canonical_district_school_email")

                if reasons:
                    reasons = sorted(set(reasons))
                    reject_counts.update(reasons)
                    reject_counts_by_dataset[dataset].update(reasons)
                    quarantine_counts[dataset] += 1
                    quarantine.append({
                        "source_dataset": dataset,
                        "source_file": path.name,
                        "source_line": source_line,
                        "rejection_reasons": reasons,
                        "district": text(record.get("district")),
                        "school": text(record.get("school")),
                        "raw_record_sha256": hashlib.sha256(json_bytes(record)).hexdigest(),
                    })
                else:
                    seen.add(dedupe_key)
                    accepted.append(canonical)
                    accepted_counts[dataset] += 1
                    mapping_method_counts[mapping_method] += 1

    accepted.sort(key=lambda r: (exact_key(r["district"]), exact_key(r["school"]), r["email"], r["record_id"]))
    quarantine.sort(key=lambda r: (r["source_dataset"], r["source_line"], ",".join(r["rejection_reasons"])))

    accepted_path = output / "accepted_contacts.jsonl.gz"
    fixture_path = output / "accepted_contacts_fixture_10.jsonl"
    allowlist_path = output / "approved_domains.txt"
    write_gzip(accepted_path, accepted)
    with fixture_path.open("wb") as fh:
        for row in accepted[:10]:
            fh.write(json_bytes(row))
    allowlist_path.write_text("".join(f"{domain}\n" for domain in approved_domains), encoding="utf-8")

    # Independent post-write validation.
    with gzip.open(accepted_path, "rt", encoding="utf-8") as fh:
        reread = [json.loads(line) for line in fh]
    assert len(reread) == len(accepted)
    assert all(tuple(row.keys()) == tuple(sorted(ACCEPTED_FIELDS)) for row in reread)
    assert len({row["record_id"] for row in reread}) == len(reread)
    assert len({(exact_key(row["district"]), exact_key(row["school"]), row["email"]) for row in reread}) == len(reread)
    assert all(email_reason(row["email"]) is None for row in reread)
    assert all(PUBLISHED_EVIDENCE_RE.match(text(row["email_source"])) is not None for row in reread)
    assert all(name_reason(row["full_name"]) is None for row in reread)
    assert all(human_url_reason(row["directory_url"]) is None for row in reread)

    districts = {row["district"] for row in accepted}
    campuses = {(row["district"], row["school"], row["canonical_source_row"]) for row in accepted}
    emails = {row["email"] for row in accepted}
    content_cutoff = max(
        canonical_utc_timestamp(row["collected_at_utc"], "collected_at_utc")
        for row in accepted
    )
    summary = {
        "schema_version": "1.0.0",
        "artifact_created_at": artifact_created_at,
        "content_cutoff_at": content_cutoff,
        "selection_policy": {
            "campus_mapping": "claimed canonical row must match district+school; otherwise exact match first, then a unique controlled TEA school-type alias match (Elementary/El, High School/H S, Junior High/J H, Middle School/Middle, Intermediate/Int); no fuzzy matching",
            "person_name": "at least two lexical name tokens; generic-only labels rejected",
            "email": "syntactically valid non-consumer work email whose evidence begins Published, Rendered, Decoded, Publicly displayed, or Public campus directory entry; missing, unsupported, inferred, and generated evidence rejected",
            "source_url": "HTTP(S) human-viewable directory URL; API, GraphQL, AJAX endpoints, JSON, and XML rejected",
            "organization_fields": "organization website, campus location label, city, county, state, and grade range are copied from the matched row of the approved workbook; missing workbook values stay empty",
            "dedupe_key": "normalized district + normalized school + lowercase email",
            "dedupe_precedence": "batch1 then batch2, stable input line order",
        },
        "inputs": {name: {"file": path.name, "rows": input_counts[name], "sha256": sha256(path)} for name, path in inputs},
        "workbook": {"file": workbook.name, "campus_rows": len(by_row), "sha256": workbook_sha256},
        "approved_domain_allowlist": {
            "file": allowlist_path.name,
            "domains": len(approved_domains),
            "sha256": sha256(allowlist_path),
            "matching_rule": "lowercase host after removing a leading www.; exact host or subdomain of an approved workbook host",
        },
        "counts": {
            "input_rows": sum(input_counts.values()),
            "accepted_rows": len(accepted),
            "quarantine_rows": len(quarantine),
            "accepted_distinct_emails": len(emails),
            "accepted_campuses": len(campuses),
            "accepted_districts": len(districts),
            "malformed_json_lines": sum(malformed.values()),
        },
        "counts_by_dataset": {
            name: {
                "input_rows": input_counts[name],
                "accepted_rows": accepted_counts[name],
                "quarantine_rows": quarantine_counts[name],
            }
            for name, _ in inputs
        },
        "accepted_fields": list(ACCEPTED_FIELDS),
        "accepted_field_nonempty_counts": {
            field: sum(1 for row in accepted if row[field] not in (None, ""))
            for field in ACCEPTED_FIELDS
        },
        "accepted_mapping_method_counts": dict(sorted(mapping_method_counts.items())),
        "campus_match_method_counts_before_other_filters": dict(sorted(campus_match_counts_all.items())),
        "comparison_to_reported_prior_audit": {
            "reported_accepted_rows": 96340,
            "reported_quarantine_rows": 11691,
            "current_accepted_delta": len(accepted) - 96340,
            "current_quarantine_delta": len(quarantine) - 11691,
            "row_level_diff_available": False,
            "explanation": "The prior manifest artifact was not present for a row-level comparison. The current bundle explicitly quarantines malformed or generic names and requires a unique workbook campus after only controlled TEA school-type aliases.",
        },
        "quarantine_reason_counts": dict(sorted(reject_counts.items())),
        "quarantine_reason_counts_by_dataset": {
            name: dict(sorted(reject_counts_by_dataset[name].items())) for name, _ in inputs
        },
        "quarantine_rows_with_multiple_reasons": sum(
            1 for row in quarantine if len(row["rejection_reasons"]) > 1
        ),
        "top_unresolved_campus_labels": [
            {"district": district, "source_school_label": school, "rows": count}
            for (district, school), count in sorted(
                unresolved_campus_counts.items(), key=lambda item: (-item[1], item[0][0], item[0][1])
            )[:25]
        ],
        "validation": {
            "input_rows_reconciled": len(accepted) + len(quarantine) == sum(input_counts.values()),
            "accepted_record_ids_unique": len({r["record_id"] for r in accepted}) == len(accepted),
            "accepted_dedupe_keys_unique": len(seen) == len(accepted),
            "accepted_schema_exact": True,
            "gzip_deterministic_mtime_zero": True,
            "post_write_reread_ok": True,
            "positive_publication_evidence_only": True,
        },
    }
    summary_path = output / "summary.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")

    script_path = Path(__file__).resolve()
    bundled_script_path = output / script_path.name
    if script_path != bundled_script_path:
        shutil.copyfile(script_path, bundled_script_path)

    accepted_sha256 = sha256(accepted_path)
    manifest = {
        "schemaVersion": 1,
        "artifactId": f"texas-accepted-contacts-{accepted_sha256[:16]}",
        "createdAt": artifact_created_at,
        "contentCutoffAt": content_cutoff,
        "jurisdiction": "texas-education",
        "workbookSha256": workbook_sha256,
        "approvedDomainAllowlistPath": allowlist_path.name,
        "approvedDomainAllowlistSha256": sha256(allowlist_path),
        "files": [{"path": accepted_path.name, "sha256": accepted_sha256}],
    }
    manifest_path = output / "legacy-contact-manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )

    checksummed = [
        accepted_path,
        fixture_path,
        allowlist_path,
        summary_path,
        bundled_script_path,
        manifest_path,
    ]
    checksum_path = output / "SHA256SUMS"
    checksum_path.write_text("".join(f"{sha256(p)}  {p.name}\n" for p in sorted(checksummed)), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
