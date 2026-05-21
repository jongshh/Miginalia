// Cloudflare Worker — OpenAI API 프록시 (Chat + TTS)
// Smart Placement 활성화 필요 (대시보드 Settings > General > Placement)
//
// 환경 변수:
// - OPENAI_API_KEY: OpenAI API 키 (Encrypt 체크)

export default {
  async fetch(request, env) {
    // CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(request.url);

    try {
      // --- TTS 엔드포인트 ---
      if (url.pathname === '/tts' || url.pathname === '/tts/') {
        const body = await request.json();

        const response = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: body.model || 'tts-1',
            input: body.input,
            voice: body.voice || 'alloy',
            speed: body.speed || 1.0,
            response_format: 'mp3',
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          return new Response(errText, {
            status: response.status,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            },
          });
        }

        const audioData = await response.arrayBuffer();
        return new Response(audioData, {
          status: 200,
          headers: {
            'Content-Type': 'audio/mpeg',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      // --- Chat Completions 엔드포인트 (기본) ---
      const body = await request.json();

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify(body),
      });

      const data = await response.text();

      return new Response(data, {
        status: response.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  },
};
