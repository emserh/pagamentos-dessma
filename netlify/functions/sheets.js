exports.handler = async function (event, context) {
  // Trata requisição OPTIONS (CORS)
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
      body: "",
    };
  }

  const targetUrl = (process.env.GOOGLE_SHEETS_URL || "")
    .trim()
    .replace(/^(["'])|(["'])$/g, "");

  if (!targetUrl) {
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        error: "Variável GOOGLE_SHEETS_URL não foi configurada no Netlify.",
      }),
    };
  }

  try {
    const cleanUrl = targetUrl.replace(/\/u\/\d+\//, "/");
    try {
      new URL(cleanUrl);
    } catch (urlError) {
      return {
        statusCode: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({
          error: "GOOGLE_SHEETS_URL está inválida. Configure uma URL completa iniciando com https://.",
        }),
      };
    }

    const fetchUrl =
      cleanUrl + (cleanUrl.includes("?") ? "&" : "?") + "_ts=" + Date.now();

    const response = await fetch(fetchUrl, {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
      },
    });

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({
          error: `O Google retornou status ${response.status}`,
        }),
      };
    }

    const data = await response.json();

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "s-maxage=60, stale-while-revalidate=300",
      },
      body: JSON.stringify(data),
    };
  } catch (err) {
    console.error("Erro na rota /api/sheets:", err);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        error: err.message || "Erro ao consultar Google Sheets",
      }),
    };
  }
};
