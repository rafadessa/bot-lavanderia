import express from 'express';
import axios from 'axios';
import cors from 'cors';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const EVOLUTION_API_URL = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const INSTANCIA = process.env.EVOLUTION_INSTANCE || 'lavanderia';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123456';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
});

const headersEvo = {
  apikey: EVOLUTION_API_KEY,
  'Content-Type': 'application/json'
};

async function iniciarBanco() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS configuracoes (
      id INT PRIMARY KEY DEFAULT 1,
      nome_lavanderia TEXT NOT NULL,
      endereco TEXT NOT NULL,
      horario TEXT NOT NULL,
      tabela_precos TEXT NOT NULL,
      regras_extras TEXT NOT NULL,
      bot_ativo_global BOOLEAN DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      telefone VARCHAR(30) UNIQUE NOT NULL,
      nome VARCHAR(120),
      endereco TEXT,
      bot_pausado BOOLEAN DEFAULT false,
      motivo_pausa TEXT,
      ultima_mensagem TEXT,
      atualizado_em TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS agendamentos (
      id SERIAL PRIMARY KEY,
      telefone VARCHAR(30) NOT NULL,
      nome VARCHAR(120) NOT NULL,
      endereco TEXT NOT NULL,
      pecas TEXT NOT NULL,
      turno VARCHAR(60) NOT NULL,
      status VARCHAR(30) DEFAULT 'Aguardando',
      criado_em TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pagamentos (
      id SERIAL PRIMARY KEY,
      telefone VARCHAR(30) NOT NULL,
      nome VARCHAR(120),
      valor NUMERIC(10, 2) NOT NULL,
      servicos TEXT DEFAULT 'Aguardando cliente informar',
      data_comprovante VARCHAR(30),
      criado_em TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mensagens (
      id SERIAL PRIMARY KEY,
      telefone VARCHAR(30) NOT NULL,
      role VARCHAR(10) NOT NULL,
      texto TEXT NOT NULL,
      criado_em TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS faq (
      id SERIAL PRIMARY KEY,
      titulo VARCHAR(150) NOT NULL,
      conteudo TEXT NOT NULL,
      criado_em TIMESTAMP DEFAULT NOW()
    );
  `);

  const { rows: cfgRows } = await pool.query('SELECT id FROM configuracoes WHERE id = 1');
  if (cfgRows.length === 0) {
    await pool.query(
      `INSERT INTO configuracoes (id, nome_lavanderia, endereco, horario, tabela_precos, regras_extras, bot_ativo_global)
       VALUES (1, $1, $2, $3, $4, $5, true)`,
      [
        'Doutor Lavanderia - Gravataí',
        'R. Jorge Amado, 503 - Gravataí/RS',
        'Todos os dias das 07h às 22h',
        '- Lavar OU Secar (Máquina Normal): R$ 17,99 por ciclo\n- Lavar OU Secar (Máquina Big): R$ 39,99 por ciclo\n- Serviço da Equipe (+ R$ 7,00): colocamos na máquina, lavamos, secamos, dobramos e embalamos!',
        'Produtos profissionais inclusos. Aceitamos PIX e Cartão.'
      ]
    );
  }
  console.log('Banco pronto!');
}

function autenticar(req, res, next) {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    return res.status(401).json({ erro: 'Não autorizado' });
  }
  next();
}

app.post('/api/login', (req, res) => {
  if (req.body.senha === ADMIN_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ erro: 'Senha incorreta' });
});

const ferramentasGemini = [
  {
    functionDeclarations: [
      {
        name: 'registrar_pagamento',
        description: 'Registra e contabiliza no sistema o valor de um comprovante de pagamento (PIX/Cartão) validado e concluído.',
        parameters: {
          type: 'OBJECT',
          properties: {
            valor: { type: 'NUMBER', description: 'Valor numérico do comprovante (ex: 60.00)' },
            data_comprovante: { type: 'STRING', description: 'Data do comprovante (ex: 27/11/2026)' },
            servicos: { type: 'STRING', description: 'Serviços referentes ao pagamento, se o cliente já tiver informado' }
          },
          required: ['valor']
        }
      },
      {
        name: 'atualizar_servicos_pagamento',
        description: 'Atualiza o último pagamento registrado do cliente com a descrição dos serviços que ele informou.',
        parameters: {
          type: 'OBJECT',
          properties: {
            servicos: { type: 'STRING', description: 'Descrição dos serviços informados pelo cliente (ex: 2 lavagens e 1 secagem)' }
          },
          required: ['servicos']
        }
      },
      {
        name: 'registrar_pedido',
        description: 'Registra um pedido ou serviço (ex: Serviço da Equipe +R$ 7) quando o cliente informar nome, peças e horário.',
        parameters: {
          type: 'OBJECT',
          properties: {
            nome: { type: 'STRING', description: 'Nome do cliente' },
            endereco: { type: 'STRING', description: 'Local ou observação' },
            pecas: { type: 'STRING', description: 'Peças ou tipo de serviço' },
            turno: { type: 'STRING', description: 'Horário ou dia' }
          },
          required: ['nome', 'endereco', 'pecas', 'turno']
        }
      },
      {
        name: 'chamar_atendente_humano',
        description: 'Pausa o bot e chama um atendente humano SOMENTE em caso de reclamação grave, peça manchada/danificada, problema em máquina, comprovante suspeito/agendado ou pedido explícito do cliente para falar com humano.',
        parameters: {
          type: 'OBJECT',
          properties: {
            motivo: { type: 'STRING', description: 'Motivo da chamada' }
          },
          required: ['motivo']
        }
      }
    ]
  }
];

async function chamarGeminiComRetry(url, payload, tentativas = 3) {
  for (let i = 0; i < tentativas; i++) {
    try {
      return await axios.post(url, payload);
    } catch (err) {
      const status = err.response?.status;
      if ((status === 503 || status === 429) && i < tentativas - 1) {
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
}

async function obterBase64Midia(data) {
  let b64 =
    data.message?.base64 ||
    data.base64 ||
    data.messageBase64 ||
    data.message?.audioMessage?.base64 ||
    data.message?.imageMessage?.base64;

  if (!b64) {
    try {
      const resMidia = await axios.post(
        `${EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${INSTANCIA}`,
        { message: { key: data.key }, convertToMp4: false },
        { headers: headersEvo }
      );
      b64 = resMidia.data?.base64;
    } catch (e) {
      console.error('Erro ao baixar mídia da Evolution:', e.response?.status, e.response?.data || e.message);
    }
  }

  if (!b64) return null;
  const limpo = b64.includes(',') ? b64.split(',')[1] : b64;
  return Buffer.from(limpo, 'base64');
}

async function processarComIA(telefone, nomeWhatsapp, inputUsuario, tipoMidia = 'text', bufferMidia = null, mimeType = null) {
  const { rows: cfgRows } = await pool.query('SELECT * FROM configuracoes WHERE id = 1');
  const cfg = cfgRows[0];

  const { rows: faqRows } = await pool.query('SELECT titulo, conteudo FROM faq ORDER BY id ASC');
  const textoFaq = faqRows.map((f) => `- ${f.titulo}: ${f.conteudo}`).join('\n');

  const { rows: msgRows } = await pool.query(
    `SELECT role, texto FROM (
       SELECT id, role, texto FROM mensagens WHERE telefone = $1 ORDER BY id DESC LIMIT 10
     ) sub ORDER BY id ASC`,
    [telefone]
  );

  const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  const systemPrompt = `
Você é a atendente virtual inteligente da ${cfg.nome_lavanderia} no WhatsApp.
Seja simpática, natural, direta e objetiva (respostas curtas estilo WhatsApp).
Data de hoje: ${hoje}.

DADOS DA LOJA:
- Endereço: ${cfg.endereco}
- Horário: ${cfg.horario}
- Regras: ${cfg.regras_extras}

TABELA DE PREÇOS:
${cfg.tabela_precos}

FAQ / DÚVIDAS:
${textoFaq}

REGRAS DE ATENDIMENTO:
1. ÁUDIOS: Você CONSEGUE ouvir áudios perfeitamente. Ouça o áudio do cliente e responda diretamente ao que ele falou. NUNCA chame atendente humano apenas porque o cliente enviou áudio.
2. COMPROVANTES DE PAGAMENTO (PIX / CARTÃO / TRANSFERÊNCIA):
   Sempre que o cliente enviar uma imagem ou documento de comprovante:
   - Verifique o STATUS: precisa ser "Concluído", "Efetuado", "Pago" ou "Transferência realizada". Se for "Agendado" ou "Em processamento", NÃO registre e NÃO dê OK — avise educadamente que consta como agendado.
   - Verifique o VALOR exato, a DATA/HORA e o DESTINATÁRIO.
   - Se parecer autêntico e concluído:
     a) CHAME obrigatoriamente a função "registrar_pagamento" passando o valor numérico exato e a data.
     b) Responda dando o OK com o valor confirmado E PERGUNTE a quais serviços esse valor se refere (ex: "Comprovante recebido e conferido! ✅ Valor de R$ 60,00 confirmado. Para eu deixar certinho aqui no sistema, esses R$ 60,00 foram referentes a quais serviços? 😊").
   - Quando o cliente responder dizendo quais serviços foram, CHAME a função "atualizar_servicos_pagamento" com a resposta dele e agradeça.
   - Se o comprovante estiver ilegível, cortado, agendado ou suspeito: informe educadamente ou acione "chamar_atendente_humano".
3. IMAGENS DE ROUPAS/MÁQUINAS: Analise a foto. Se for roupa manchada, danificada ou problema em máquina, peça desculpas e acione "chamar_atendente_humano".
4. PEDIDOS: Se o cliente quiser agendar o Serviço da Equipe (+R$ 7), colete Nome, Peças e Turno e chame "registrar_pedido".
5. Cliente no WhatsApp: ${nomeWhatsapp || 'Cliente'}.
`;

  const contents = [];
  for (const r of msgRows) {
    const role = r.role === 'model' ? 'model' : 'user';
    if (contents.length === 0 && role === 'model') continue;
    if (contents.length > 0 && contents[contents.length - 1].role === role) {
      contents[contents.length - 1].parts[0].text += `\n${r.texto}`;
    } else {
      contents.push({ role, parts: [{ text: r.texto }] });
    }
  }

  const userParts = [];
  if ((tipoMidia === 'image' || tipoMidia === 'audio' || tipoMidia === 'document') && bufferMidia && bufferMidia.length > 0) {
    userParts.push({
      inlineData: {
        mimeType: mimeType || (tipoMidia === 'audio' ? 'audio/ogg' : 'image/jpeg'),
        data: bufferMidia.toString('base64')
      }
    });
    if (tipoMidia === 'audio') {
      userParts.push({ text: 'Ouça atentamente este áudio do cliente e responda diretamente ao que ele perguntou ou disse.' });
    } else {
      userParts.push({ text: inputUsuario || 'Analise esta imagem/documento. Se for comprovante de pagamento válido e concluído, chame registrar_pagamento e pergunte a quais serviços o valor se refere.' });
    }
  } else {
    userParts.push({ text: inputUsuario });
  }

  contents.push({ role: 'user', parts: userParts });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

  let resposta = await chamarGeminiComRetry(url, {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    tools: ferramentasGemini
  });

  const candidate = resposta.data.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const functionCallPart = parts.find((p) => p.functionCall);

  if (functionCallPart) {
    const { name, args } = functionCallPart.functionCall;
    let resultadoFuncao = {};

    if (name === 'registrar_pagamento') {
      await pool.query(
        `INSERT INTO pagamentos (telefone, nome, valor, servicos, data_comprovante)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          telefone,
          nomeWhatsapp || 'Cliente',
          Number(args.valor) || 0,
          args.servicos || 'Aguardando cliente informar',
          args.data_comprovante || hoje
        ]
      );
      resultadoFuncao = { sucesso: true, mensagem: 'Pagamento contabilizado no sistema.' };
    } else if (name === 'atualizar_servicos_pagamento') {
      await pool.query(
        `UPDATE pagamentos
         SET servicos = $1
         WHERE id = (SELECT id FROM pagamentos WHERE telefone = $2 ORDER BY id DESC LIMIT 1)`,
        [args.servicos, telefone]
      );
      resultadoFuncao = { sucesso: true, mensagem: 'Serviços vinculados ao pagamento.' };
    } else if (name === 'registrar_pedido') {
      await pool.query(
        `INSERT INTO agendamentos (telefone, nome, endereco, pecas, turno, status) VALUES ($1, $2, $3, $4, $5, 'Aguardando')`,
        [telefone, args.nome, args.endereco, args.pecas, args.turno]
      );
      await pool.query(`UPDATE leads SET nome = $1, endereco = $2 WHERE telefone = $3`, [args.nome, args.endereco, telefone]);
      resultadoFuncao = { sucesso: true, mensagem: 'Pedido registrado.' };
    } else if (name === 'chamar_atendente_humano') {
      await pool.query(`UPDATE leads SET bot_pausado = true, motivo_pausa = $1 WHERE telefone = $2`, [args.motivo, telefone]);
      resultadoFuncao = { sucesso: true, mensagem: 'Humano chamado.' };
    }

    contents.push(candidate.content);
    contents.push({ role: 'user', parts: [{ functionResponse: { name, response: resultadoFuncao } }] });

    resposta = await chamarGeminiComRetry(url, {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      tools: ferramentasGemini
    });
  }

  return (
    resposta.data.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text ||
    'Entendido! Como posso ajudar mais?'
  );
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const { data } = req.body;
    if (!data?.key) return;

    const { fromMe, remoteJid } = data.key;
    if (fromMe || !remoteJid || remoteJid.includes('@g.us') || remoteJid.includes('broadcast')) return;

    const telefone = remoteJid.split('@')[0];
    const pushName = data.pushName || 'Cliente';

    let textoMensagem = data.message?.conversation || data.message?.extendedTextMessage?.text || '';
    let tipoMidia = 'text';
    let bufferMidia = null;
    let mimeType = null;

    const audioMessage = data.message?.audioMessage || data.message?.pttMessage;
    if (audioMessage) {
      tipoMidia = 'audio';
      mimeType = (audioMessage.mimetype || 'audio/ogg').split(';')[0].trim();
      textoMensagem = '[Áudio do cliente]';
      bufferMidia = await obterBase64Midia(data);
    }

    const imageMessage = data.message?.imageMessage;
    if (imageMessage) {
      tipoMidia = 'image';
      mimeType = (imageMessage.mimetype || 'image/jpeg').split(';')[0].trim();
      textoMensagem = imageMessage.caption || '[Imagem enviada pelo cliente]';
      bufferMidia = await obterBase64Midia(data);
    }

    const documentMessage = data.message?.documentMessage || data.message?.documentWithCaptionMessage?.message?.documentMessage;
    if (documentMessage && documentMessage.mimetype === 'application/pdf') {
      tipoMidia = 'document';
      mimeType = 'application/pdf';
      textoMensagem = documentMessage.caption || '[Comprovante PDF enviado pelo cliente]';
      bufferMidia = await obterBase64Midia(data);
    }

    if (!textoMensagem && !bufferMidia) return;

    await pool.query(
      `INSERT INTO leads (telefone, nome, ultima_mensagem, atualizado_em)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (telefone)
       DO UPDATE SET ultima_mensagem = EXCLUDED.ultima_mensagem, atualizado_em = NOW()`,
      [telefone, pushName, textoMensagem]
    );

    await pool.query(`INSERT INTO mensagens (telefone, role, texto) VALUES ($1, 'user', $2)`, [telefone, textoMensagem]);

    const { rows: cfgRows } = await pool.query('SELECT bot_ativo_global FROM configuracoes WHERE id = 1');
    const { rows: leadRows } = await pool.query('SELECT bot_pausado FROM leads WHERE telefone = $1', [telefone]);

    if (!cfgRows[0]?.bot_ativo_global || leadRows[0]?.bot_pausado) return;

    const respostaIA = await processarComIA(telefone, pushName, textoMensagem, tipoMidia, bufferMidia, mimeType);

    await pool.query(`INSERT INTO mensagens (telefone, role, texto) VALUES ($1, 'model', $2)`, [telefone, respostaIA]);

    await axios.post(
      `${EVOLUTION_API_URL}/message/sendText/${INSTANCIA}`,
      { number: telefone, text: respostaIA },
      { headers: headersEvo }
    );
  } catch (erro) {
    console.error('Erro no webhook:', erro.response?.data || erro.message);
  }
});

// Rotas do painel
app.get('/api/resumo', autenticar, async (req, res) => {
  const leads = await pool.query('SELECT COUNT(*) FROM leads');
  const pausados = await pool.query('SELECT COUNT(*) FROM leads WHERE bot_pausado = true');
  const pedidosAtivos = await pool.query("SELECT COUNT(*) FROM agendamentos WHERE status NOT IN ('Entregue', 'Cancelado')");
  const faturado = await pool.query('SELECT COALESCE(SUM(valor), 0) AS total FROM pagamentos');
  res.json({
    totalLeads: Number(leads.rows[0].count),
    aguardandoHumano: Number(pausados.rows[0].count),
    pedidosAtivos: Number(pedidosAtivos.rows[0].count),
    totalFaturado: Number(faturado.rows[0].total)
  });
});

app.get('/api/pagamentos', autenticar, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM pagamentos ORDER BY criado_em DESC LIMIT 50');
  res.json(rows);
});

app.get('/api/agendamentos', autenticar, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM agendamentos ORDER BY criado_em DESC');
  res.json(rows);
});

app.patch('/api/agendamentos/:id', autenticar, async (req, res) => {
  await pool.query('UPDATE agendamentos SET status = $1 WHERE id = $2', [req.body.status, req.params.id]);
  res.json({ ok: true });
});

app.get('/api/leads', autenticar, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM leads ORDER BY atualizado_em DESC');
  res.json(rows);
});

app.patch('/api/leads/:id/toggle-bot', autenticar, async (req, res) => {
  await pool.query('UPDATE leads SET bot_pausado = $1, motivo_pausa = CASE WHEN $1 = false THEN NULL ELSE motivo_pausa END WHERE id = $2', [req.body.bot_pausado, req.params.id]);
  res.json({ ok: true });
});

app.get('/api/leads/:telefone/mensagens', autenticar, async (req, res) => {
  const { rows } = await pool.query('SELECT role, texto, criado_em FROM mensagens WHERE telefone = $1 ORDER BY id ASC LIMIT 50', [req.params.telefone]);
  res.json(rows);
});

app.get('/api/faq', autenticar, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM faq ORDER BY id DESC');
  res.json(rows);
});

app.post('/api/faq', autenticar, async (req, res) => {
  const { titulo, conteudo } = req.body;
  await pool.query('INSERT INTO faq (titulo, conteudo) VALUES ($1, $2)', [titulo, conteudo]);
  res.json({ ok: true });
});

app.delete('/api/faq/:id', autenticar, async (req, res) => {
  await pool.query('DELETE FROM faq WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/config', autenticar, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM configuracoes WHERE id = 1');
  res.json(rows[0]);
});

app.put('/api/config', autenticar, async (req, res) => {
  const { nome_lavanderia, endereco, horario, tabela_precos, regras_extras, bot_ativo_global } = req.body;
  await pool.query(
    `UPDATE configuracoes SET nome_lavanderia=$1, endereco=$2, horario=$3, tabela_precos=$4, regras_extras=$5, bot_ativo_global=$6 WHERE id = 1`,
    [nome_lavanderia, endereco, horario, tabela_precos, regras_extras, bot_ativo_global]
  );
  res.json({ ok: true });
});

app.get('/api/whatsapp/status', autenticar, async (req, res) => {
  try {
    const { data } = await axios.get(`${EVOLUTION_API_URL}/instance/connectionState/${INSTANCIA}`, { headers: headersEvo });
    res.json({ conectado: data?.instance?.state === 'open', status: data?.instance?.state });
  } catch {
    res.json({ conectado: false, status: 'desconectado' });
  }
});

app.get('/api/whatsapp/conectar', autenticar, async (req, res) => {
  try {
    const { numero } = req.query;
    const url = numero ? `${EVOLUTION_API_URL}/instance/connect/${INSTANCIA}?number=${numero.replace(/\D/g, '')}` : `${EVOLUTION_API_URL}/instance/connect/${INSTANCIA}`;
    const { data } = await axios.get(url, { headers: headersEvo });
    res.json({ qrcode: data.base64 || null, pairingCode: data.pairingCode || null });
  } catch {
    res.status(500).json({ erro: 'Erro ao gerar conexão.' });
  }
});

app.post('/api/whatsapp/desconectar', autenticar, async (req, res) => {
  try {
    await axios.delete(`${EVOLUTION_API_URL}/instance/logout/${INSTANCIA}`, { headers: headersEvo });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ erro: 'Erro ao desconectar.' });
  }
});

iniciarBanco().then(() => app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`)));
