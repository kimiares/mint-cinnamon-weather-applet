#!/usr/bin/env python3
"""
Simple job-scraper for djinni.co, work.ua and robota.ua.
This is a best-effort, standalone script that fetches the three pages and
extracts job entries (title, company if available, location if available, url, source).

Usage:
  python3 jobs/scrape_jobs.py --query ".NET"

Outputs JSON array to stdout.

Note: requires requests and beautifulsoup4 (see requirements.txt).

Site-specific strategies
------------------------
djinni.co   — HTML page; cards are <div class="job-item">; title in
              <h2 class="job-item__position">, company in first
              <span class="small text-gray-800 opacity-75">, link on
              <a class="job_item__header-link">.

work.ua     — HTML page; cards are <div class="card … job-link">;
              title in <h2 class="my-0"><a>, company in
              <span class="strong-600">.

robota.ua   — Angular SPA (HTML is essentially empty).  Uses the public
              REST API at api.robota.ua/vacancy/search which returns JSON
              (no auth required).
"""

import argparse
import json
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

SITES = {
    "djinni": "https://djinni.co/jobs/?primary_keyword={q}",
    "workua": "https://www.work.ua/jobs-{q}/",
    # robota.ua is a SPA; we query their public search API directly
    "robota": (
        "https://api.robota.ua/vacancy/search"
        "?keyWords={q}&cityId=0&page=0&count=30"
    ),
}

# Matches a djinni job-detail path like /jobs/695878-senior-net-developer/
_DJINNI_JOB_RE = re.compile(r"^/jobs/\d+-[^/]+/?$")

# Matches a work.ua job-detail path like /jobs/8116809/
_WORKUA_JOB_RE = re.compile(r"^/jobs/\d+/?$")


def fetch(url):
    try:
        r = requests.get(url, headers=HEADERS, timeout=15)
        r.raise_for_status()
        return r.text
    except Exception as e:
        print(f"Error fetching {url}: {e}")
        return ""


# ---------------------------------------------------------------------------
# djinni.co
# ---------------------------------------------------------------------------

def parse_djinni(html):
    """Parse djinni.co search results page.

    Each job card is a <div class="job-item …">.  Within it:
    - <a class="job_item__header-link">  →  href with the job URL
    - <h2 class="job-item__position">   →  job title
    - <span class="small text-gray-800 opacity-75 …">  →  company name
    """
    soup = BeautifulSoup(html, 'html.parser')
    base = 'https://djinni.co'
    jobs = []
    seen = set()

    cards = [
        tag for tag in soup.find_all(True)
        if 'job-item' in ' '.join(tag.get('class', []))
    ]

    for card in cards:
        # title
        h2 = card.find('h2', class_=lambda c: c and 'job-item__position' in c)
        title = h2.get_text(strip=True) if h2 else None

        # link — the wrapper anchor that covers the whole header
        a_tag = card.find('a', class_=lambda c: c and 'job_item__header-link' in c)
        if not a_tag:
            # Fallback: first anchor whose href matches the job-detail pattern
            a_tag = card.find('a', href=_DJINNI_JOB_RE)
        if not a_tag:
            continue

        href = a_tag.get('href', '')
        if not _DJINNI_JOB_RE.match(href):
            continue

        url = urljoin(base, href)
        if url in seen:
            continue
        seen.add(url)

        # company — the small grey text right under the title inside the link
        company_span = a_tag.find(
            'span',
            class_=lambda c: c and 'text-gray-800' in c and 'small' in c,
        )
        company = company_span.get_text(strip=True) if company_span else None

        if not title:
            title = a_tag.get_text(separator=' ', strip=True)

        jobs.append({
            'title': title,
            'company': company or None,
            'location': None,
            'url': url,
        })

    return jobs


# ---------------------------------------------------------------------------
# work.ua
# ---------------------------------------------------------------------------

def parse_workua(html):
    """Parse work.ua search results page.

    Each job card is a <div class="card … job-link …">.  Within it:
    - <h2 class="my-0"><a href="/jobs/NNNN/">  →  title and URL
    - <span class="strong-600">               →  company name
    """
    soup = BeautifulSoup(html, 'html.parser')
    base = 'https://www.work.ua'
    jobs = []
    seen = set()

    cards = soup.find_all(
        'div',
        class_=lambda c: c and 'job-link' in c and 'card' in c,
    )

    for card in cards:
        h2 = card.find('h2', class_='my-0')
        if not h2:
            continue
        a_tag = h2.find('a', href=True)
        if not a_tag:
            continue

        href = a_tag.get('href', '')
        if not _WORKUA_JOB_RE.match(href):
            continue

        url = urljoin(base, href)
        if url in seen:
            continue
        seen.add(url)

        title = a_tag.get_text(strip=True)

        # Company: first <span class="strong-600"> inside the card
        company_span = card.find('span', class_=lambda c: c and 'strong-600' in c)
        company = company_span.get_text(strip=True) if company_span else None

        jobs.append({
            'title': title,
            'company': company or None,
            'location': None,
            'url': url,
        })

    return jobs


# ---------------------------------------------------------------------------
# robota.ua  (public JSON API — no authentication required)
# ---------------------------------------------------------------------------

def parse_robota(api_response):
    """Parse the robota.ua vacancy search API JSON response.

    The API returns a JSON object with a ``documents`` list.  Each entry has:
    - id           →  used to build the vacancy URL
    - notebookId   →  employer notebook ID (also in URL)
    - name         →  job title
    - companyName  →  company
    - cityName     →  location
    """
    jobs = []
    try:
        data = json.loads(api_response)
    except (json.JSONDecodeError, ValueError):
        return jobs

    for doc in data.get('documents', []):
        vacancy_id = doc.get('id')
        notebook_id = doc.get('notebookId')
        title = doc.get('name', '').strip()
        company = doc.get('companyName', '').strip() or None
        location = doc.get('cityName', '').strip() or None

        if not vacancy_id or not title:
            continue

        # Canonical vacancy URL used on the site
        if notebook_id:
            url = f"https://robota.ua/company/{notebook_id}/vacancy/{vacancy_id}"
        else:
            url = f"https://robota.ua/vacancy/{vacancy_id}"

        jobs.append({
            'title': title,
            'company': company,
            'location': location,
            'url': url,
        })

    return jobs


def dedupe(jobs):
    out = []
    seen = set()
    for j in jobs:
        key = j.get('url') or (j.get('title') + '|' + (j.get('company') or ''))
        if key in seen:
            continue
        seen.add(key)
        out.append(j)
    return out


def run(query):
    q = query.strip()
    q_enc = quote_plus(q)
    # work.ua expects a hyphenated path like 'net-developer'
    q_dash = q.replace('.', '').replace(' ', '-').lower().strip('-')
    results = []

    # Djinni
    url = SITES['djinni'].format(q=q_enc)
    html = fetch(url)
    if html:
        items = parse_djinni(html)
        for it in items:
            it['source'] = 'djinni'
            results.append(it)

    # work.ua
    url = SITES['workua'].format(q=q_dash)
    html = fetch(url)
    if html:
        items = parse_workua(html)
        for it in items:
            it['source'] = 'work.ua'
            results.append(it)

    # robota.ua
    url = SITES['robota'].format(q=quote_plus(q))
    html = fetch(url)
    if html:
        items = parse_robota(html)
        for it in items:
            it['source'] = 'robota.ua'
            results.append(it)

    results = dedupe(results)
    return results


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Scrape job listings from three sites (best-effort).')
    parser.add_argument('--query', '-q', default='.NET', help='Search query (e.g. ".NET").')
    parser.add_argument('--output', '-o', help='Output file (JSON). If omitted prints to stdout.')
    args = parser.parse_args()

    items = run(args.query)
    data = json.dumps(items, ensure_ascii=False, indent=2)
    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(data)
        print(f'Wrote {len(items)} items to {args.output}')
    else:
        print(data)
