
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const DEFAULT_EMDN_CODE = "W0105090108";

const DATA_LAKE =
  "https://api.datalake.sante.service.ec.europa.eu/eudamed";

app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: true }));

function getArray(data) {
  if (Array.isArray(data)) return data;

  return data?.value || data?.content || data?.data || [];
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `API error ${response.status}: ${body.slice(0, 500)}`
    );
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error("The API did not return valid JSON.");
  }
}

// Fetch device records using pagination
async function searchDevices(code) {
  const url = new URL(`${DATA_LAKE}/udi`);

  url.searchParams.set("NOMENCLATURE_CODE", ` ${code}`);
  url.searchParams.set("format", "json");
  url.searchParams.set("api-version", "v1.0");

  let nextUrl = url.toString();
  let page = 0;

  const allRows = [];
  const seenUrls = new Set();
  const MAX_PAGES = 50;

  while (nextUrl && page < MAX_PAGES) {
    if (seenUrls.has(nextUrl)) {
      throw new Error("Repeated pagination URL detected.");
    }

    seenUrls.add(nextUrl);

    const data = await fetchJson(nextUrl);
    allRows.push(...getArray(data));
    page++;

    if (data.nextLink) {
      nextUrl = new URL(data.nextLink, nextUrl).toString();
    } else {
      nextUrl = null;
    }
  }

  if (nextUrl) {
    console.warn(
      `EUDAMED pagination stopped at ${MAX_PAGES} pages. More records may exist.`
    );
  }

  return allRows;
}

// Load official risk-class reference labels
async function loadRiskClasses() {
  const url = new URL(`${DATA_LAKE}/reference`);

  url.searchParams.set("CODE", "RISK_CLASS_ID");
  url.searchParams.set("LANGUAGE", "en");
  url.searchParams.set("format", "json");
  url.searchParams.set("api-version", "v1.0");

  const data = await fetchJson(url.toString());

  return getArray(data)
    .map((item) => {
      const id = item.ID ?? item.id;
      const label =
        item.VALUE ??
        item.value ??
        item.NAME ??
        item.name ??
        item.LABEL ??
        item.label;

      return {
        id: id == null ? "" : String(id),
        label: label == null ? "" : String(label),
      };
    })
    .filter((item) => item.id && item.label);
}

function getRiskId(row) {
  const value = row.RISK_CLASS_ID;

  if (value === null || value === undefined || value === "") {
    return "unknown";
  }

  return String(value);
}

function prepareRows(rows, riskClasses) {
  const riskMap = new Map(
    riskClasses.map((risk) => [risk.id, risk.label])
  );

  return rows.map((row) => {
    const riskId = getRiskId(row);

    return {
      ...row,
      riskId,
      riskLabel:
        riskMap.get(riskId) ||
        (riskId === "unknown"
          ? "Risk class unavailable"
          : `Risk ID: ${riskId}`),
    };
  });
}

function getAvailableRiskClasses(rows, referenceClasses) {
  const usedIds = new Set(rows.map((row) => row.riskId));

  const referenceMap = new Map(
    referenceClasses.map((risk) => [risk.id, risk.label])
  );

  return [...usedIds]
    .sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true })
    )
    .map((id) => ({
      id,
      label:
        referenceMap.get(id) ||
        (id === "unknown"
          ? "Risk class unavailable"
          : `Risk ID: ${id}`),
    }));
}

async function renderSearchPage({
  res,
  code,
  selectedRisk = "all",
}) {
  const [rawRows, referenceClasses] = await Promise.all([
    searchDevices(code),
    loadRiskClasses(),
  ]);

  const allRows = prepareRows(rawRows, referenceClasses);

  const riskClasses = getAvailableRiskClasses(
    allRows,
    referenceClasses
  );

  const rows =
    selectedRisk === "all"
      ? allRows
      : allRows.filter(
          (row) => row.riskId === selectedRisk
        );

  return res.render("index", {
    code,
    rows,
    riskClasses,
    selectedRisk,
    error: "",
    totalRecords: allRows.length,
  });
}

app.get("/", async (req, res) => {
  try {
    await renderSearchPage({
      res,
      code: DEFAULT_EMDN_CODE,
      selectedRisk: "all",
    });
  } catch (error) {
    console.error("Home page error:", error.message);

    res.status(502).render("index", {
      code: DEFAULT_EMDN_CODE,
      rows: [],
      riskClasses: [],
      selectedRisk: "all",
      error: error.message,
      totalRecords: 0,
    });
  }
});

app.post("/search", async (req, res) => {
  const code = String(
    req.body.code || DEFAULT_EMDN_CODE
  ).trim();

  const selectedRisk = String(
    req.body.riskClass || "all"
  );

  if (!/^[A-Za-z0-9-]{2,100}$/.test(code)) {
    return res.status(400).render("index", {
      code,
      rows: [],
      riskClasses: [],
      selectedRisk: "all",
      error: "Please enter a valid EMDN code.",
      totalRecords: 0,
    });
  }

  try {
    await renderSearchPage({
      res,
      code,
      selectedRisk,
    });
  } catch (error) {
    console.error("Search error:", error.message);

    res.status(502).render("index", {
      code,
      rows: [],
      riskClasses: [],
      selectedRisk: "all",
      error: error.message,
      totalRecords: 0,
    });
  }
});

app.listen(PORT, () => {
  console.log(`EUDAMED Explorer running on port ${PORT}`);
});
