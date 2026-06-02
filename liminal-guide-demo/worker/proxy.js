// Cloudflare Worker — OpenAI API + Supabase 프록시
// 이 Worker는 Chat, TTS, DB 연동, RAG 문서 업로드를 통합하여 처리합니다.

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, openai-beta',
      'Access-Control-Max-Age': '86400',
    };

    // CORS Preflight 처리
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, ""); // 트레일링 슬래시 제거

    try {
      // --- 1. TTS 엔드포인트 ---
      if (path === '/tts') {
        if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
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
          return new Response(errText, { status: response.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const audioData = await response.arrayBuffer();
        return new Response(audioData, {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'audio/mpeg' },
        });
      }

      // --- 2. DB 연동 (Supabase) /archive 엔드포인트 ---
      if (path === '/archive') {
        const hasSupabase = env.SUPABASE_URL && env.SUPABASE_KEY;

        // POST /archive: 새로운 채팅 내역을 DB에 저장
        if (request.method === 'POST') {
          const body = await request.json();
          const { nickname, text } = body;

          if (!nickname || !text) {
            return new Response(JSON.stringify({ error: 'Missing nickname or text' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }

          if (hasSupabase) {
            const res = await fetch(`${env.SUPABASE_URL}/rest/v1/visitor_chats`, {
              method: 'POST',
              headers: {
                'apikey': env.SUPABASE_KEY,
                'Authorization': `Bearer ${env.SUPABASE_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=representation'
              },
              body: JSON.stringify({ nickname, text })
            });

            if (!res.ok) {
              const err = await res.text();
              throw new Error(`Supabase Insert Failed: ${err}`);
            }

            const data = await res.json();
            return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          } else {
            // DB 미설정 시 임시 성공 처리 (로컬과 유사하게 동작)
            return new Response(JSON.stringify({ ok: true, warning: 'Supabase not configured', data: { nickname, text, created_at: new Date().toISOString() } }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
        }

        // GET /archive: 최신 30개 채팅 반환 (티커용)
        if (request.method === 'GET') {
          if (hasSupabase) {
            const res = await fetch(`${env.SUPABASE_URL}/rest/v1/visitor_chats?select=nickname,text,created_at&order=id.desc&limit=30`, {
              method: 'GET',
              headers: {
                'apikey': env.SUPABASE_KEY,
                'Authorization': `Bearer ${env.SUPABASE_KEY}`
              }
            });

            if (!res.ok) {
              const err = await res.text();
              throw new Error(`Supabase Fetch Failed: ${err}`);
            }

            const data = await res.json();
            // 티커 형식인 `> 닉네임: 텍스트` 구조로 맵핑
            const formatted = data.map(item => ({
              text: `> ${item.nickname}: ${item.text}`,
              created_at: item.created_at
            }));

            return new Response(JSON.stringify(formatted), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          } else {
            // DB 미설정 시 기본 하드코딩 리스트 반환
            const mockData = [
              { text: "> 관객_라이: 넌 왜 그렇게 생각하는건데?" },
              { text: "> 관객_가이드: 너는 누구야?" }
            ];
            return new Response(JSON.stringify(mockData), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
        }

        return new Response('Method not allowed', { status: 405, headers: corsHeaders });
      }

      // --- 3. OpenAI Assistants API RAG 대화 (/chat) ---
      if (path === '/chat') {
        if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
        const body = await request.json();
        const { message, threadId: clientThreadId, systemPrompt, assistantId: customAssistantId } = body;

        const assistantId = customAssistantId || env.OPENAI_ASSISTANT_ID;

        // Assistant ID가 없으면 기존 Chat Completions (GPT-4o-mini)로 폴백 작동
        if (!assistantId) {
          const chatResponse = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
              model: 'gpt-4o-mini',
              response_format: { type: 'json_object' },
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: message }
              ],
              temperature: body.temperature || 0.5,
            }),
          });

          if (!chatResponse.ok) {
            const errBody = await chatResponse.text();
            return new Response(errBody, { status: chatResponse.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }

          const chatData = await chatResponse.json();
          const parsedContent = JSON.parse(chatData.choices[0].message.content);
          return new Response(JSON.stringify({
            docent_text: parsedContent.docent_text,
            switch_to_artwork_id: parsedContent.switch_to_artwork_id || null,
            isFallback: true
          }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const headers = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2'
        };

        // 1) Thread 조회 또는 생성
        let threadId = clientThreadId;
        if (!threadId) {
          const threadRes = await fetch('https://api.openai.com/v1/threads', {
            method: 'POST',
            headers
          });
          if (!threadRes.ok) throw new Error(`Thread creation failed: ${await threadRes.text()}`);
          const threadData = await threadRes.json();
          threadId = threadData.id;
        }

        // 2) 사용자 메시지를 Thread에 생성
        const msgRes = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            role: 'user',
            content: message
          })
        });
        if (!msgRes.ok) throw new Error(`Message creation failed: ${await msgRes.text()}`);

        // 3) Run 실행 (System Prompt로 어시스턴트 지침을 완전히 덮어씀)
        const runRes = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            assistant_id: assistantId,
            instructions: systemPrompt,
            response_format: { type: 'json_object' }
          })
        });
        if (!runRes.ok) throw new Error(`Run execution failed: ${await runRes.text()}`);
        const runData = await runRes.json();
        const runId = runData.id;

        // 4) Polling 대기 (최대 30초)
        const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
        let runStatus = runData.status;
        let attempts = 0;

        while ((runStatus === 'queued' || runStatus === 'in_progress') && attempts < 60) {
          await delay(500);
          const checkRes = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, { headers });
          if (!checkRes.ok) throw new Error(`Run polling failed: ${await checkRes.text()}`);
          const checkData = await checkRes.json();
          runStatus = checkData.status;
          attempts++;
        }

        if (runStatus !== 'completed') {
          throw new Error(`Run ended with unexpected status: ${runStatus}`);
        }

        // 5) 최신 AI 메시지 로드
        const messagesRes = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages?limit=1`, { headers });
        if (!messagesRes.ok) throw new Error(`Failed to retrieve messages: ${await messagesRes.text()}`);
        const messagesData = await messagesRes.json();

        const latestMsg = messagesData.data[0];
        if (!latestMsg || latestMsg.role !== 'assistant') {
          throw new Error('Latest message is not from assistant');
        }

        const textContent = latestMsg.content[0].text.value;
        const parsedContent = JSON.parse(textContent);

        return new Response(JSON.stringify({
          docent_text: parsedContent.docent_text,
          switch_to_artwork_id: parsedContent.switch_to_artwork_id || null,
          threadId: threadId,
          isFallback: false
        }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      // --- 4. 어시스턴트 및 벡터스토어 원클릭 셋업 (/setup-assistant) ---
      if (path === '/setup-assistant') {
        if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
        const headers = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2'
        };

        // 1) Vector Store 생성
        const vsRes = await fetch('https://api.openai.com/v1/vector_stores', {
          method: 'POST',
          headers,
          body: JSON.stringify({ name: 'Miginalia Exhibition Docs' })
        });
        if (!vsRes.ok) throw new Error(`Vector store creation failed: ${await vsRes.text()}`);
        const vsData = await vsRes.json();
        const vectorStoreId = vsData.id;

        // 2) Assistant 생성
        const assistRes = await fetch('https://api.openai.com/v1/assistants', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            name: '라이(Rai) - RAG Docent',
            instructions: '당신은 미술관 도슨트 AI 라이(Rai)입니다. 대화 중인 관람객을 지칭할 때는 절대 "관람객님", "관객님", "관람객", "관객" 등의 일반 호칭을 사용하지 마십시오. 대신 systemPrompt에서 지시하는 상대의 설정된 닉네임을 사용하여 닉네임과 "님"을 결합하여(Phase 1, 2) 부르거나 반말로 닉네임만 단독으로(Phase 3) 부르십시오. 관람객에게 파일에 기술된 작품 정보를 충실히 가이드해주되, 예술적/학술적 맥락을 풍부하게 하기 위해 해당 작품의 개념을 유명 비엔날레(베니스 비엔날레, 광주 비엔날레 등)의 다른 작품이나 미술사적 흐름, 사조 등 외부 지식과 결합하여 풍성한 감상을 제공해야 합니다. 반드시 한 문장 이상의 미술사적 연계 및 해석을 덧붙이십시오.',
            tools: [{ type: 'file_search' }],
            tool_resources: {
              file_search: {
                vector_store_ids: [vectorStoreId]
              }
            },
            model: 'gpt-4o-mini'
          })
        });
        if (!assistRes.ok) throw new Error(`Assistant creation failed: ${await assistRes.text()}`);
        const assistData = await assistRes.json();
        const assistantId = assistData.id;

        return new Response(JSON.stringify({
          ok: true,
          assistantId,
          vectorStoreId,
          message: 'Assistant & Vector Store set up successfully. Please add these IDs to your environment variables.'
        }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      // --- 5. RAG 파일 업로드 및 벡터스토어 연동 (/upload-document) ---
      if (path === '/upload-document') {
        if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
        const vectorStoreId = env.OPENAI_VECTOR_STORE_ID;
        if (!vectorStoreId) {
          return new Response(JSON.stringify({ error: 'OPENAI_VECTOR_STORE_ID is not configured in Worker environment' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        // 파일은 multipart/form-data로 넘어옵니다. 그대로 OpenAI 파일 업로드 API로 중계합니다.
        const contentType = request.headers.get('content-type');
        if (!contentType || !contentType.includes('multipart/form-data')) {
          return new Response(JSON.stringify({ error: 'Content-Type must be multipart/form-data' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        // 들어온 multipart body를 그대로 넘기기 위해 raw request body 읽음
        const bodyArrayBuffer = await request.arrayBuffer();

        // 1) OpenAI Files API 업로드
        const fileUploadRes = await fetch('https://api.openai.com/v1/files', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
            'Content-Type': contentType,
          },
          body: bodyArrayBuffer
        });

        if (!fileUploadRes.ok) {
          const errText = await fileUploadRes.text();
          throw new Error(`OpenAI File Upload Failed: ${errText}`);
        }

        const fileData = await fileUploadRes.json();
        const fileId = fileData.id;

        // 2) Vector Store에 파일 바인딩
        const vsFileRes = await fetch(`https://api.openai.com/v1/vector_stores/${vectorStoreId}/files`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
            'OpenAI-Beta': 'assistants=v2'
          },
          body: JSON.stringify({ file_id: fileId })
        });

        if (!vsFileRes.ok) {
          const errText = await vsFileRes.text();
          throw new Error(`OpenAI Vector Store File Link Failed: ${errText}`);
        }

        const vsFileData = await vsFileRes.json();

        return new Response(JSON.stringify({
          ok: true,
          fileId,
          vectorStoreId,
          vsFile: vsFileData
        }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      return new Response('Not found', { status: 404, headers: corsHeaders });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
};
