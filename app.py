from flask import Flask, render_template, jsonify, request, Response
import mysql.connector
import os, csv, io, json, re, requests
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)

DB_CONFIG = {
    "host": "127.0.0.1",
    "port": 3306,
    "user": "root",
    "password": "",
    "database": "einvoicing",
    "charset": "utf8mb4",
}

GROQ_API_KEY   = os.environ.get("GROQ_API_KEY", "")
TAVILY_API_KEY = os.environ.get("TAVILY_API_KEY", "")
GROQ_URL       = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL     = "llama-3.1-8b-instant"

FIELDS = [
    "b2g", "b2b", "b2c",
    "b2g_date", "b2g_staggered",
    "b2b_date", "b2b_staggered",
    "b2c_date", "b2c_staggered",
    "non_local_suppliers", "digital_services_suppliers",
    "ap", "ar", "import_txn", "export_txn",
    "intra_eu_sales", "intra_eu_purchases",
    "zero_rated", "exempt", "e_reporting",
    "tax_authority", "format", "source"
]


def get_db():
    return mysql.connector.connect(**DB_CONFIG)


def resolve_sources(country, tax_authority, data):
    """Search Tavily with multiple queries to get best official URLs."""
    if not TAVILY_API_KEY:
        return "Information Not Available"
    try:
        # Run 2 targeted searches and combine results
        queries = [
            f"{country} e-invoicing official government tax authority",
            f"{tax_authority} e-invoice regulation {country}",
        ]

        all_urls = []
        for query in queries:
            app.logger.info(f"[Tavily] {query}")
            resp = requests.post(
                "https://api.tavily.com/search",
                json={
                    "api_key": TAVILY_API_KEY,
                    "query": query,
                    "search_depth": "advanced",
                    "max_results": 3,
                    "include_answer": False,
                },
                timeout=20
            )
            if resp.ok:
                for r in resp.json().get("results", []):
                    url = r.get("url", "")
                    if url and url.startswith("http") and url not in all_urls:
                        all_urls.append(url)
            if len(all_urls) >= 3:
                break

        if all_urls:
            return "|".join(all_urls[:3])
        return "Information Not Available"

    except Exception as e:
        app.logger.warning(f"Tavily failed for {country}: {e}")
        return "Information Not Available"


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/countries")
def get_countries():
    conn = get_db()
    cur  = conn.cursor(dictionary=True)
    cur.execute("SELECT * FROM countries ORDER BY region, country")
    rows = cur.fetchall()
    cur.close(); conn.close()
    for r in rows:
        for k in ("last_updated", "created_at"):
            if r.get(k): r[k] = r[k].isoformat()
    return jsonify(rows)


@app.route("/api/country/<int:cid>")
def get_country(cid):
    conn = get_db()
    cur  = conn.cursor(dictionary=True)
    cur.execute("SELECT * FROM countries WHERE id=%s", (cid,))
    row = cur.fetchone()
    cur.close(); conn.close()
    if not row: return jsonify({"error": "Not found"}), 404
    for k in ("last_updated", "created_at"):
        if row.get(k): row[k] = row[k].isoformat()
    return jsonify(row)


@app.route("/api/country/<int:cid>", methods=["PUT"])
def update_country(cid):
    data = request.json or {}
    conn = get_db()
    cur  = conn.cursor()
    allowed = FIELDS + ["status"]
    sets, vals = [], []
    for f in allowed:
        if f in data:
            sets.append(f"`{f}`=%s")
            vals.append(data[f])
    if not sets: return jsonify({"error": "Nothing to update"}), 400
    sets.append("`last_updated`=NOW()")
    vals.append(cid)
    cur.execute(f"UPDATE countries SET {', '.join(sets)} WHERE id=%s", vals)
    conn.commit()
    cur.close(); conn.close()
    return jsonify({"ok": True})


@app.route("/api/research/<int:cid>", methods=["POST"])
def research_country(cid):
    if not GROQ_API_KEY:
        return jsonify({"ok": False, "error": "GROQ_API_KEY not set in .env"}), 500

    conn = get_db()
    cur  = conn.cursor(dictionary=True)
    cur.execute("SELECT * FROM countries WHERE id=%s", (cid,))
    row = cur.fetchone()
    if not row:
        cur.close(); conn.close()
        return jsonify({"error": "Not found"}), 404

    cur2 = conn.cursor()
    cur2.execute("UPDATE countries SET status='fetching', last_updated=NOW() WHERE id=%s", (cid,))
    conn.commit()
    cur2.close(); cur.close(); conn.close()

    country = row["country"]
    region  = row["region"]

    prompt = f"""You are a senior e-invoicing compliance expert with deep knowledge of global tax regulations up to 2025. You have studied official government mandates, tax authority publications, and regulatory frameworks worldwide.

Your task: Provide accurate e-invoicing regulatory data for {country} ({region}).

FIELD DEFINITIONS:
- b2g: Is e-invoicing mandatory/voluntary for Business-to-Government transactions?
- b2b: Is e-invoicing mandatory/voluntary for Business-to-Business transactions?
- b2c: Is e-invoicing mandatory/voluntary for Business-to-Consumer transactions?
- b2g_date / b2b_date / b2c_date: Implementation date of the mandate
- b2g_staggered / b2b_staggered / b2c_staggered: Was rollout phased by company size/sector? (Y=yes phased, N=all at once)
- non_local_suppliers: Does the mandate apply to foreign/non-resident suppliers?
- digital_services_suppliers: Does it apply to suppliers of digital services?
- ap: Are accounts payable (incoming invoices) in scope?
- ar: Are accounts receivable (outgoing invoices) in scope?
- import_txn: Are import transactions in scope?
- export_txn: Are export transactions in scope?
- intra_eu_sales: Are intra-EU cross-border sales in scope? (N/A if not EU member)
- intra_eu_purchases: Are intra-EU cross-border purchases in scope? (N/A if not EU member)
- zero_rated: Are zero-rated VAT transactions in scope?
- exempt: Are VAT-exempt transactions in scope?
- e_reporting: Is there a separate e-reporting/digital reporting obligation (even if no full e-invoice mandate)?
- tax_authority: Full official name of the national tax authority
- format: Technical format required (e.g. PEPPOL BIS 3.0, UBL 2.1, XML, JSON, Factur-X, FatturaPA, etc.)

ACCURACY RULES:
- Use "Mandatory" only if a law has been enacted and is in force or officially announced
- Use "Voluntary" if the government encourages but does not require e-invoicing
- Use "N/A" if the field does not apply to {country} (e.g. no VAT system, not EU member)
- Use "Unknown" only if you genuinely have no reliable information
- NEVER generate URLs — set source to NOT_AVAILABLE
- NEVER guess or hallucinate — accuracy is critical for compliance purposes

DATE RULES (very important):
- Always provide the MOST RECENT and CURRENT implementation date as of 2025
- If a mandate was updated or amended, use the LATEST effective date, not the original
- If rollout is still ongoing (staggered), provide the FINAL phase completion date
- If a future date has been announced (e.g. 2025, 2026), include it and mark b2g_staggered/b2b_staggered accordingly
- Format: YYYY-MM-DD for single dates, "YYYY-MM-DD to YYYY-MM-DD" for ranges
- Use "TBD" only if officially announced but date not yet confirmed
- NEVER provide historical/superseded dates — always the current active or upcoming date

Return ONLY a raw JSON object, no markdown fences, no explanation:

{{
  "b2g": "Mandatory" or "Voluntary" or "N/A" or "Unknown",
  "b2b": "Mandatory" or "Voluntary" or "N/A" or "Unknown",
  "b2c": "Mandatory" or "Voluntary" or "N/A" or "Unknown",
  "b2g_date": "YYYY-MM-DD or date range or TBD or N/A or Unknown",
  "b2g_staggered": "Y" or "N" or "N/A" or "Unknown",
  "b2b_date": "YYYY-MM-DD or date range or TBD or N/A or Unknown",
  "b2b_staggered": "Y" or "N" or "N/A" or "Unknown",
  "b2c_date": "YYYY-MM-DD or date range or TBD or N/A or Unknown",
  "b2c_staggered": "Y" or "N" or "N/A" or "Unknown",
  "non_local_suppliers": "Y" or "N" or "N/A" or "Unknown",
  "digital_services_suppliers": "Y" or "N" or "N/A" or "Unknown",
  "ap": "Y" or "N" or "N/A" or "Unknown",
  "ar": "Y" or "N" or "N/A" or "Unknown",
  "import_txn": "Y" or "N" or "N/A" or "Unknown",
  "export_txn": "Y" or "N" or "N/A" or "Unknown",
  "intra_eu_sales": "Y" or "N" or "N/A",
  "intra_eu_purchases": "Y" or "N" or "N/A",
  "zero_rated": "Y" or "N" or "N/A" or "Unknown",
  "exempt": "Y" or "N" or "N/A" or "Unknown",
  "e_reporting": "Y" or "N" or "N/A" or "Unknown",
  "tax_authority": "Full official name of tax authority",
  "format": "Technical format standard used",
  "source": "NOT_AVAILABLE"
}}"""

    try:
        import time

        def call_groq():
            return requests.post(
                GROQ_URL,
                headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
                json={"model": GROQ_MODEL, "messages": [{"role": "user", "content": prompt}], "temperature": 0.1, "max_tokens": 1500},
                timeout=60
            )

        resp = call_groq()
        if resp.status_code == 429:
            app.logger.warning(f"[{cid}] Rate limited, waiting 20s...")
            time.sleep(20)
            resp = call_groq()

        if not resp.ok:
            raise ValueError(f"Groq HTTP {resp.status_code}: {resp.text[:300]}")

        text = resp.json()["choices"][0]["message"]["content"]
        text = re.sub(r"```(?:json)?", "", text).strip().rstrip("```").strip()

        match = re.search(r"\{[\s\S]*\}", text)
        if not match:
            raise ValueError(f"No JSON in response: {text[:300]!r}")

        data = json.loads(match.group(0))

        # Fetch real source URLs via Tavily
        tax_auth    = data.get("tax_authority", country)
        data["source"] = resolve_sources(country, tax_auth, data)

        conn2 = get_db()
        cur3  = conn2.cursor()
        sets  = [f"`{f}`=%s" for f in FIELDS] + ["`status`='done'", "`last_updated`=NOW()"]
        vals  = [data.get(f) for f in FIELDS] + [cid]
        cur3.execute(f"UPDATE countries SET {', '.join(sets)} WHERE id=%s", vals)
        conn2.commit()
        cur3.close(); conn2.close()

        return jsonify({"ok": True, "data": data})

    except Exception as e:
        app.logger.error(f"[research {cid}] ERROR: {e}")
        conn3 = get_db()
        cur4  = conn3.cursor()
        cur4.execute("UPDATE countries SET status='error', last_updated=NOW() WHERE id=%s", (cid,))
        conn3.commit()
        cur4.close(); conn3.close()
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/stats")
def stats():
    conn = get_db()
    cur  = conn.cursor(dictionary=True)
    cur.execute("""SELECT COUNT(*) AS total, SUM(status='done') AS done,
        SUM(status='pending') AS pending, SUM(status='error') AS error,
        SUM(status='fetching') AS fetching FROM countries""")
    row = cur.fetchone()
    cur.close(); conn.close()
    return jsonify(row)


@app.route("/api/refetch-sources", methods=["POST"])
def refetch_sources():
    """Re-fetch Tavily URLs for all done countries."""
    conn = get_db()
    cur  = conn.cursor(dictionary=True)
    cur.execute("SELECT * FROM countries WHERE status='done' OR source IS NULL OR source='NOT_AVAILABLE' OR source='Information Not Available'")
    rows = cur.fetchall()
    cur.close(); conn.close()

    import time
    updated = 0
    for row in rows:
        try:
            source = resolve_sources(row["country"], row.get("tax_authority", row["country"]), row)
            conn2 = get_db()
            cur2  = conn2.cursor()
            cur2.execute("UPDATE countries SET source=%s WHERE id=%s", (source, row["id"]))
            conn2.commit()
            cur2.close(); conn2.close()
            updated += 1
            time.sleep(0.5)
        except Exception as e:
            app.logger.error(f"refetch error {row['country']}: {e}")

    return jsonify({"ok": True, "updated": updated})



@app.route("/api/reset", methods=["POST"])
def reset_countries():
    """Reset selected countries back to pending with all fields cleared."""
    ids = request.json.get("ids", [])
    if not ids:
        return jsonify({"error": "No ids provided"}), 400
    conn = get_db()
    cur  = conn.cursor()
    placeholders = ",".join(["%s"] * len(ids))
    cur.execute(f"""UPDATE countries SET
        status='pending', b2g=NULL, b2b=NULL, b2c=NULL,
        b2g_date=NULL, b2g_staggered=NULL,
        b2b_date=NULL, b2b_staggered=NULL,
        b2c_date=NULL, b2c_staggered=NULL,
        non_local_suppliers=NULL, digital_services_suppliers=NULL,
        ap=NULL, ar=NULL, import_txn=NULL, export_txn=NULL,
        intra_eu_sales=NULL, intra_eu_purchases=NULL,
        zero_rated=NULL, exempt=NULL, e_reporting=NULL,
        tax_authority=NULL, format=NULL, source=NULL,
        last_updated=NOW()
        WHERE id IN ({placeholders})""", ids)
    conn.commit()
    cur.close(); conn.close()
    return jsonify({{"ok": True, "reset": len(ids)}})

@app.route("/api/export/csv")
def export_csv():
    conn = get_db()
    cur  = conn.cursor(dictionary=True)
    cur.execute("SELECT * FROM countries ORDER BY region, country")
    rows = cur.fetchall()
    cur.close(); conn.close()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "Region", "Country", "B2G", "B2B", "B2C",
        "B2G Date", "B2G Staggered", "B2B Date", "B2B Staggered",
        "B2C Date", "B2C Staggered", "Non-Local Suppliers",
        "Digital Services Suppliers", "AP", "AR", "Import", "Export",
        "Intra-EU Sales", "Intra-EU Purchases", "Zero-rated", "Exempt",
        "E-reporting", "Tax Authority", "Format", "Source"
    ])
    for r in rows:
        writer.writerow([
            r["region"], r["country"],
            r["b2g"] or "", r["b2b"] or "", r["b2c"] or "",
            r["b2g_date"] or "", r["b2g_staggered"] or "",
            r["b2b_date"] or "", r["b2b_staggered"] or "",
            r["b2c_date"] or "", r["b2c_staggered"] or "",
            r["non_local_suppliers"] or "", r["digital_services_suppliers"] or "",
            r["ap"] or "", r["ar"] or "",
            r["import_txn"] or "", r["export_txn"] or "",
            r["intra_eu_sales"] or "", r["intra_eu_purchases"] or "",
            r["zero_rated"] or "", r["exempt"] or "", r["e_reporting"] or "",
            r["tax_authority"] or "", r["format"] or "", r["source"] or ""
        ])

    csv_bytes = ("\ufeff" + output.getvalue()).encode("utf-8")
    return Response(csv_bytes, mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=E-invoicing_Research.csv"})


@app.route("/api/test")
def test():
    import traceback
    results = {}
    results["groq_key_set"]     = bool(GROQ_API_KEY)
    results["groq_key_preview"] = GROQ_API_KEY[:12] + "..." if GROQ_API_KEY else "NOT SET"
    results["tavily_key_set"]   = bool(TAVILY_API_KEY)

    try:
        import requests as r
        results["requests_installed"] = True
    except ImportError as e:
        results["requests_installed"] = False
        return jsonify(results)

    try:
        resp = requests.post(GROQ_URL,
            headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
            json={"model": GROQ_MODEL, "messages": [{"role": "user", "content": "Say hello"}], "max_tokens": 10},
            timeout=15)
        results["groq_status_code"] = resp.status_code
        results["groq_ok"]          = resp.ok
        results["groq_response"]    = resp.text[:300]
    except Exception as e:
        results["groq_error"] = str(e)

    if TAVILY_API_KEY:
        try:
            tr = requests.post("https://api.tavily.com/search",
                json={"api_key": TAVILY_API_KEY, "query": "India GST e-invoicing mandatory", "max_results": 2},
                timeout=15)
            results["tavily_status"]     = tr.status_code
            results["tavily_ok"]         = tr.ok
            results["tavily_sample_url"] = tr.json().get("results", [{}])[0].get("url", "none") if tr.ok else tr.text[:200]
        except Exception as e:
            results["tavily_error"] = str(e)

    try:
        conn = get_db()
        cur  = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM countries")
        results["db_count"] = cur.fetchone()[0]
        cur.close(); conn.close()
        results["db_ok"] = True
    except Exception as e:
        results["db_ok"]    = False
        results["db_error"] = str(e)

    return jsonify(results)


if __name__ == "__main__":
    app.run(debug=True, port=5000)
