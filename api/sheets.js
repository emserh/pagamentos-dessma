export default async function handler(req, res) {
  // Permite requisições do próprio app
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const targetUrl = process.env.GOOGLE_SHEETS_URL;
  if (!targetUrl) {
    return res.status(500).json({
      error: 'Variável de ambiente GOOGLE_SHEETS_URL não foi configurada na Vercel.'
    });
  }

  try {
    // Remove qualquer trecho indesejado de multi-contas e adiciona timestamp anti-cache
    const cleanUrl = targetUrl.replace(/\/u\/\d+\//, '/');
    const fetchUrl = cleanUrl + (cleanUrl.includes('?') ? '&' : '?') + '_ts=' + Date.now();

    const response = await fetch(fetchUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/plain, */*'
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: `O Google retornou status ${response.status}`
      });
    }

    const data = await response.json();

    // Cache na CDN da Vercel: atualiza a cada 60s, mantendo o carregamento ultra rápido
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json(data);
  } catch (err) {
    console.error('Erro na rota /api/sheets:', err);
    return res.status(500).json({ error: err.message || 'Erro ao consultar Google Sheets' });
  }
}
