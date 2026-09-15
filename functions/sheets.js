export default async function handler(req, res) {
  // Trata pré-requisição CORS (OPTIONS)
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      },
    });
  }

  const targetUrl = process.env.GOOGLE_SHEETS_URL;
  if (!targetUrl) {
    return new Response(
      JSON.stringify({
        error: "Variável GOOGLE_SHEETS_URL não foi configurada no Netlify.",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  try {
    const cleanUrl = targetUrl.replace(/\/u\/\d+\//, "/");
    const fetchUrl =
      cleanUrl + (cleanUrl.includes("?") ? "&" : "?") + "_ts=" + Date.now();

    const response = await fetch(fetchUrl, {
      method: "GET",
      headers: { Accept: "application/json, text/plain, */*" },
    });

    if (!response.ok) {
      return new Response(
        JSON.stringify({
          error: `O Google Apps Script retornou status ${response.status}`,
        }),
        {
          status: response.status,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const data = await response.json();

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "s-maxage=60, stale-while-revalidate=300",
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: err.message || "Erro ao consultar Google Sheets",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
