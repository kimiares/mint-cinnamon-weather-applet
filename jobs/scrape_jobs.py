#!/usr/bin/env python3
"""
Job-scraper for sites defined in sites.json.

Two parsing strategies driven entirely by config — no site-specific code:
  html — parse HTML with BeautifulSoup using CSS selectors from sites.json
  api  — call a JSON REST API and extract structured fields from sites.json

Usage:
  python3 jobs/scrape_jobs.py --query ".NET"

Outputs JSON array to stdout.
Requires: requests, beautifulsoup4  (see requirements.txt)
"""

import argparse
import json
import os
import re

import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin, quote_plus

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    )
}

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SITES_FILE = os.path.join(_SCRIPT_DIR, "sites.json")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_sites(path=SITES_FILE):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        raise SystemExit(f"Error: sites config not found: {path}")
    except json.JSONDecodeError as e:
        raise SystemExit(f"Error: invalid JSON in {path}: {e}")
    if not isinstance(data, list):
        raise SystemExit(f"Error: {path} must contain a JSON array of site configs")
    return data


def encode_query(q, method):
    """Encode a query string for a given URL-construction method."""
    if method == "quote_plus":
        return quote_plus(q)
    if method == "dash":
        # work.ua-style: ".NET developer" → "net-developer"
        # Strip non-word chars (dots, slashes, parens, plus…), collapse to hyphens
        cleaned = re.sub(r"[^\w\s-]", "", q)
        return re.sub(r"[\s_]+", "-", cleaned).lower().strip("-")
    return q


def fetch(url):
    try:
        r = requests.get(url, headers=HEADERS, timeout=15)
        r.raise_for_status()
        return r.text
    except Exception as e:
        print(f"Error fetching {url}: {e}")
        return ""


def _class_matches(element_classes, required):
    """Return True if all required class(es) are present in element_classes."""
    if not element_classes:
        return False
    if isinstance(required, list):
        return all(k in element_classes for k in required)
    return required in element_classes


# ---------------------------------------------------------------------------
# Generic HTML parser — handles djinni.co, work.ua and any future HTML site
# ---------------------------------------------------------------------------

def parse_html_jobs(html, cfg):
    """Parse an HTML job-listings page using selectors defined in cfg.

    Supported cfg keys
    ------------------
    base_url            str         Used to build absolute URLs.
    card_tag            str         Tag of the job-card element.
    card_class          str|list    Class(es) that must be present on the card.
    href_re             str         Regex the job-detail href must match.
    link_wrapper_tag    str (opt)   Intermediate wrapper tag (e.g. "h2").
    link_wrapper_class  str (opt)   Class on the wrapper (exact BeautifulSoup match).
    link_class          str (opt)   Class on the <a> link tag.
    title_tag           str (opt)   Tag holding the title; if absent, anchor text is used.
    title_class         str (opt)   Class on the title tag.
    company_tag         str (opt)   Tag holding the company name.
    company_class       str|list    Class(es) on the company tag.
    """
    for required in ("base_url", "card_tag", "card_class", "href_re"):
        if required not in cfg:
            raise ValueError(f"parse_html_jobs: missing required config key '{required}' in site '{cfg.get('name', '?')}'")
    soup = BeautifulSoup(html, "html.parser")
    base = cfg["base_url"]
    href_re = re.compile(cfg["href_re"])
    card_class = cfg["card_class"]
    jobs = []
    seen = set()

    cards = soup.find_all(
        cfg["card_tag"],
        class_=lambda c: _class_matches(c, card_class),
    )

    for card in cards:
        # Optionally narrow anchor-search scope to a wrapper element
        search_root = card
        if cfg.get("link_wrapper_tag"):
            wrapper = card.find(
                cfg["link_wrapper_tag"],
                class_=cfg.get("link_wrapper_class"),
            )
            if wrapper:
                search_root = wrapper

        # Find the job-detail anchor
        link_class = cfg.get("link_class")
        if link_class:
            a_tag = search_root.find("a", class_=lambda c: c and link_class in c)
            if not a_tag:
                a_tag = search_root.find("a", href=href_re)
        else:
            a_tag = search_root.find("a", href=True)

        if not a_tag:
            continue

        href = a_tag.get("href", "")
        if not href_re.match(href):
            continue

        url = urljoin(base, href)
        if url in seen:
            continue
        seen.add(url)

        # Title: from dedicated tag, or fall back to anchor text
        title_tag = cfg.get("title_tag")
        if title_tag:
            title_class = cfg.get("title_class")
            t = (
                card.find(title_tag, class_=lambda c: c and title_class in c)
                if title_class
                else card.find(title_tag)
            )
            title = t.get_text(strip=True) if t else a_tag.get_text(separator=" ", strip=True)
        else:
            title = a_tag.get_text(strip=True)

        # Company (optional)
        company = None
        company_tag = cfg.get("company_tag")
        if company_tag:
            company_class = cfg.get("company_class")
            cs = (
                card.find(company_tag, class_=lambda c: _class_matches(c, company_class))
                if company_class
                else card.find(company_tag)
            )
            company = cs.get_text(strip=True) if cs else None

        jobs.append({"title": title, "company": company or None, "location": None, "url": url})

    return jobs


# ---------------------------------------------------------------------------
# API parser — handles robota.ua and any future REST/JSON site
# ---------------------------------------------------------------------------

def parse_api_jobs(response_text, cfg):
    """Parse a JSON REST API response using field names from cfg.

    Supported cfg keys
    ------------------
    items_path      str     Key in the JSON object that holds the list of items.
    id_field        str     Field name for the vacancy ID.
    title_field     str     Field name for the job title.
    notebook_field  str     Field name for the employer ID (used in URL).
    company_field   str     Field name for the company name.
    location_field  str     Field name for the city/location.
    url_pattern     str     URL template with {id} and {notebookId} placeholders.
    url_fallback    str     URL template with only {id} (used when notebook absent).
    """
    for required in ("items_path", "id_field", "title_field"):
        if required not in cfg:
            raise ValueError(f"parse_api_jobs: missing required config key '{required}' in site '{cfg.get('name', '?')}'")
    jobs = []
    try:
        data = json.loads(response_text)
    except (json.JSONDecodeError, ValueError):
        return jobs

    notebook_field = cfg.get("notebook_field", "")

    for doc in data.get(cfg["items_path"], []):
        vacancy_id = doc.get(cfg["id_field"])
        title = doc.get(cfg["title_field"], "").strip()
        if not vacancy_id or not title:
            continue

        company = (doc.get(cfg.get("company_field", "")) or "").strip() or None
        location = (doc.get(cfg.get("location_field", "")) or "").strip() or None
        notebook_id = doc.get(notebook_field) if notebook_field else None

        if notebook_id is not None and "url_pattern" in cfg:
            url = cfg["url_pattern"].format(id=vacancy_id, notebookId=notebook_id)
        elif "url_fallback" in cfg:
            url = cfg["url_fallback"].format(id=vacancy_id)
        else:
            continue  # no URL can be constructed — skip this entry

        jobs.append({"title": title, "company": company, "location": location, "url": url})

    return jobs


# ---------------------------------------------------------------------------
# Deduplication & main runner
# ---------------------------------------------------------------------------

def dedupe(jobs):
    out = []
    seen = set()
    for j in jobs:
        key = j.get("url") or (j.get("title", "") + "|" + (j.get("company") or ""))
        if key in seen:
            continue
        seen.add(key)
        out.append(j)
    return out


def run(query, sites=None):
    if sites is None:
        sites = load_sites()

    results = []
    for site in sites:
        q = encode_query(query.strip(), site.get("query_encoding", "quote_plus"))
        url = site["url_template"].format(q=q)
        response = fetch(url)
        if not response:
            continue

        if site["type"] == "html":
            items = parse_html_jobs(response, site)
        elif site["type"] == "api":
            items = parse_api_jobs(response, site)
        else:
            continue

        label = site.get("label", site["name"])
        for it in items:
            it["source"] = label
        results.extend(items)

    return dedupe(results)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Scrape job listings from sites defined in sites.json."
    )
    parser.add_argument("--query", "-q", default=".NET", help='Search query (e.g. ".NET").')
    parser.add_argument("--output", "-o", help="Output file (JSON). If omitted, prints to stdout.")
    args = parser.parse_args()

    items = run(args.query)
    data = json.dumps(items, ensure_ascii=False, indent=2)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(data)
        print(f"Wrote {len(items)} items to {args.output}")
    else:
        print(data)

