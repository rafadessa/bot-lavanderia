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
app.use(express.json());
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

// ==========================================
// INTELIGÊNCIA MULTIMODAL (TEXTO, ÁUDIO E FOTO)
// ==========================================
const ferramentasGemini = [
  {
    functionDeclarations: [
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
        description: 'Pausa o bot e chama um atendente humano em caso de reclamação, peça manchada, problema em máquina ou foto de dúvida complexa.',
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

  const systemPrompt = `
Você é a atendente virtual da ${cfg.nome_lavanderia} no WhatsApp.
Seja extremamente simpática, prestativa e objetiva (respostas curtas estilo WhatsApp).

DADOS DA LOJA:
- Endereço: ${cfg.endereco}
- Horário: ${cfg.horario}
- Regras: ${cfg.regras_extras}

TABELA DE PREÇOS:
${cfg.tabela_precos}

FAQ / DÚVIDAS:
${textoFaq}

REGRAS:
1. Responda com base na tabela e FAQ. Se mandarem foto de roupa manchada ou com problema, peça desculpas e acione "chamar_atendente_humano".
2. Se mandarem áudio ou texto querendo agendar o Serviço da Equipe (+R$ 7) ou deixar roupas, colete Nome, Peças e Turno e chame "registrar_pedido".
3. Cliente no WhatsApp: ${nomeWhatsapp || 'Cliente'}.
`;

  // Monta o histórico para o Gemini
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

  // Prepara a mensagem atual (Texto, Áudio ou Imagem)
  const userParts = [];
  if (tipoMidia === 'image' || tipoMidia === 'audio') {
    userParts.push({
      inlineData: {
        mimeType: mimeType,
        data: bufferMidia.toString('base64')
      }
    });
    userParts.push({ text: inputUsuario || 'Analise esta mídia e responda ao cliente de acordo com as regras da lavanderia.' });
  } else {
    userParts.push({ text: inputUsuario });
  }

  contents.push({ role: 'user', parts: userParts });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

  let resposta = await axios.post(url, {
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

    if (name === 'registrar_pedido') {
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

    resposta = await axios.post(url, {
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

// ==========================================
// WEBHOOK ROBUSTO COM SUPORTE A MÍDIA
// ==========================================
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

    // Detecta Áudio
    const audioMessage = data.message?.audioMessage || data.message?.pttMessage;
    if (audioMessage) {
      tipoMidia = 'audio';
      mimeType = audioMessage.mimetype || 'audio/ogg';
      // Baixa o áudio da Evolution API
      const base64Audio = data.messageBase64 || audioMessage.base64;
      if (base64Audio) {
        bufferMidia = Buffer.from(base64Audio, 'base64');
      } else {
        // Tenta buscar via API caso venha URL
        try {
          const resMidia = await axios.post(`${EVOLUTION_API_URL}/chat/getBase64FromMedia/${INSTANCIA}`, { message: data }, { headers: headersEvo });
          if (resMidia.data?.base64) {
            bufferMidia = Buffer.from(resMidia.data.base64.split(',')[1] || resMidia.data.base64, 'base64');
          }
        } catch (e) {
          console.log('Erro ao baixar áudio:', e.message);
        }
      }
      textoMensagem = '[O cliente enviou um áudio]';
    }

    // Detecta Imagem
    const imageMessage = data.message?.imageMessage;
    if (imageMessage) {
      tipoMidia = 'image';
      mimeType = imageMessage.mimetype || 'image/jpeg';
      textoMensagem = imageMessage.caption || '[O cliente enviou uma imagem]';
      const base64Image = data.messageBase64 || imageMessage.base64;
      if (base64Image) {
        bufferMidia = Buffer.from(base64Image, 'base64');
      } else {
        try {
          const resMidia = await axios.post(`${EVOLUTION_API_URL}/chat/getBase64FromMedia/${INSTANCIA}`, { message: data }, { headers: headersEvo });
          if (resMidia.data?.base64) {
            bufferMidia = Buffer.from(resMidia.data.base64.split(',')[1] || resMidia.data.base64, 'base64');
          }
        } catch (e) {
          console.log('Erro ao baixar imagem:', e.message);
        }
      }
    }

    if (!textoMensagem && !bufferMidia) return;

    // Salva lead e mensagem
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

    // Processa com a IA Multimodal
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
  res.json({ totalLeads: Number(leads.rows[0].count), aguardandoHumano: Number(pausados.rows[0].count), pedidosAtivos: Number(pedidosAtivos.rows[0].count) });
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
