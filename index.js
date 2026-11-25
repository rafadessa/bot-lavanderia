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

// ==========================================
// 1. CRIAÇÃO AUTOMÁTICA DO BANCO DE DADOS
// ==========================================
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
      status VARCHAR(30) DEFAULT 'Pendente',
      criado_em TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mensagens (
      id SERIAL PRIMARY KEY,
      telefone VARCHAR(30) NOT NULL,
      role VARCHAR(10) NOT NULL,
      texto TEXT NOT NULL,
      criado_em TIMESTAMP DEFAULT NOW()
    );
  `);

  const { rows } = await pool.query('SELECT id FROM configuracoes WHERE id = 1');
  if (rows.length === 0) {
    await pool.query(
      `INSERT INTO configuracoes (id, nome_lavanderia, endereco, horario, tabela_precos, regras_extras, bot_ativo_global)
       VALUES (1, $1, $2, $3, $4, $5, true)`,
      [
        'Lavanderia Express',
        'Rua Exemplo, 123 - Centro',
        'Segunda a Sexta das 08h às 18h | Sábado das 08h às 12h',
        '- Camisa social: R$ 15,00\n- Calça jeans/social: R$ 18,00\n- Terno completo: R$ 45,00\n- Edredom solteiro: R$ 35,00\n- Edredom casal/Queen: R$ 45,00\n- Edredom King: R$ 55,00\n- Roupa por quilo: R$ 22,00/kg\n- Tênis: R$ 30,00',
        'Prazo padrão: 48h úteis. Coleta e entrega: R$ 10,00 (grátis acima de R$ 80,00). Aceitamos PIX, cartão e dinheiro.'
      ]
    );
  }
  console.log('Banco de dados pronto!');
}

// ==========================================
// 2. AUTENTICAÇÃO SIMPLES DO PAINEL
// ==========================================
function autenticar(req, res, next) {
  const senha = req.headers['x-admin-password'];
  if (senha !== ADMIN_PASSWORD) {
    return res.status(401).json({ erro: 'Senha incorreta' });
  }
  next();
}

app.post('/api/login', (req, res) => {
  if (req.body.senha === ADMIN_PASSWORD) {
    return res.json({ ok: true });
  }
  res.status(401).json({ erro: 'Senha incorreta' });
});

// ==========================================
// 3. INTELIGÊNCIA ARTIFICIAL (GEMINI + TOOLS)
// ==========================================
function formatarHistoricoGemini(rows) {
  const contents = [];
  for (const row of rows) {
    const role = row.role === 'model' ? 'model' : 'user';
    if (contents.length === 0 && role === 'model') continue;
    if (contents.length > 0 && contents[contents.length - 1].role === role) {
      contents[contents.length - 1].parts[0].text += `\n${row.texto}`;
    } else {
      contents.push({ role, parts: [{ text: row.texto }] });
    }
  }
  return contents;
}

const ferramentasGemini = [
  {
    functionDeclarations: [
      {
        name: 'registrar_agendamento',
        description: 'Registra um agendamento de coleta de roupas quando o cliente já informou nome, endereço completo, peças e turno.',
        parameters: {
          type: 'OBJECT',
          properties: {
            nome: { type: 'STRING', description: 'Nome completo do cliente' },
            endereco: { type: 'STRING', description: 'Endereço completo para coleta' },
            pecas: { type: 'STRING', description: 'Lista das peças que serão lavadas' },
            turno: { type: 'STRING', description: 'Dia e turno preferido (ex: Hoje à tarde, Amanhã de manhã)' }
          },
          required: ['nome', 'endereco', 'pecas', 'turno']
        }
      },
      {
        name: 'chamar_atendente_humano',
        description: 'Pausa o robô e chama um humano em caso de reclamação, peça danificada, ou orçamento de peça fora da tabela.',
        parameters: {
          type: 'OBJECT',
          properties: {
            motivo: { type: 'STRING', description: 'Resumo curto do motivo da transferência' }
          },
          required: ['motivo']
        }
      }
    ]
  }
];

async function processarComIA(telefone, nomeWhatsapp) {
  const { rows: cfgRows } = await pool.query('SELECT * FROM configuracoes WHERE id = 1');
  const cfg = cfgRows[0];

  const { rows: msgRows } = await pool.query(
    `SELECT role, texto FROM (
       SELECT id, role, texto FROM mensagens WHERE telefone = $1 ORDER BY id DESC LIMIT 12
     ) sub ORDER BY id ASC`,
    [telefone]
  );

  const systemPrompt = `
Você é a atendente virtual da ${cfg.nome_lavanderia} no WhatsApp.
Seja simpática, natural e objetiva (respostas curtas de WhatsApp, sem textões).

DADOS DA LAVANDERIA:
- Endereço: ${cfg.endereco}
- Horário: ${cfg.horario}
- Regras e entregas: ${cfg.regras_extras}

TABELA DE PREÇOS:
${cfg.tabela_precos}

REGRAS OBRIGATÓRIAS:
1. Nunca invente preços. Se o cliente pedir orçamento de algo fora da tabela, use a função "chamar_atendente_humano".
2. Se o cliente quiser agendar coleta, pergunte: Nome (se ainda não souber), Endereço completo, quais peças vai enviar e melhor dia/turno. Assim que tiver tudo, chame a função "registrar_agendamento".
3. Se o cliente reclamar de roupa manchada/danificada ou atraso, peça desculpas e chame "chamar_atendente_humano".
4. Nome do contato no WhatsApp: ${nomeWhatsapp || 'Não informado'}.
`;

  const contents = formatarHistoricoGemini(msgRows);
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

    if (name === 'registrar_agendamento') {
      await pool.query(
        `INSERT INTO agendamentos (telefone, nome, endereco, pecas, turno) VALUES ($1, $2, $3, $4, $5)`,
        [telefone, args.nome, args.endereco, args.pecas, args.turno]
      );
      await pool.query(
        `UPDATE leads SET nome = $1, endereco = $2 WHERE telefone = $3`,
        [args.nome, args.endereco, telefone]
      );
      resultadoFuncao = { sucesso: true, mensagem: 'Agendamento salvo no sistema com sucesso.' };
    } else if (name === 'chamar_atendente_humano') {
      await pool.query(
        `UPDATE leads SET bot_pausado = true, motivo_pausa = $1 WHERE telefone = $2`,
        [args.motivo, telefone]
      );
      resultadoFuncao = { sucesso: true, mensagem: 'Atendente humano notificado e bot pausado.' };
    }

    // Segunda chamada para a IA confirmar ao cliente em linguagem natural
    contents.push(candidate.content);
    contents.push({
      role: 'user',
      parts: [{ functionResponse: { name, response: resultadoFuncao } }]
    });

    resposta = await axios.post(url, {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      tools: ferramentasGemini
    });
  }

  const textoFinal =
    resposta.data.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text ||
    'Desculpe, tive uma instabilidade aqui. Pode repetir?';

  return textoFinal;
}

// ==========================================
// 4. WEBHOOK DA EVOLUTION API
// ==========================================
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const { data } = req.body;
    if (!data?.key) return;

    const { fromMe, remoteJid } = data.key;
    if (fromMe || !remoteJid || remoteJid.includes('@g.us') || remoteJid.includes('broadcast')) return;

    const texto = data.message?.conversation || data.message?.extendedTextMessage?.text;
    if (!texto) return;

    const telefone = remoteJid.split('@')[0];
    const pushName = data.pushName || 'Cliente';

    // Salva ou atualiza o Lead
    await pool.query(
      `INSERT INTO leads (telefone, nome, ultima_mensagem, atualizado_em)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (telefone)
       DO UPDATE SET ultima_mensagem = EXCLUDED.ultima_mensagem, atualizado_em = NOW()`,
      [telefone, pushName, texto]
    );

    // Salva mensagem do cliente
    await pool.query(
      `INSERT INTO mensagens (telefone, role, texto) VALUES ($1, 'user', $2)`,
      [telefone, texto]
    );

    // Verifica se o bot está ativo (globalmente e para este lead)
    const { rows: cfgRows } = await pool.query('SELECT bot_ativo_global FROM configuracoes WHERE id = 1');
    const { rows: leadRows } = await pool.query('SELECT bot_pausado FROM leads WHERE telefone = $1', [telefone]);

    if (!cfgRows[0]?.bot_ativo_global || leadRows[0]?.bot_pausado) return;

    const respostaIA = await processarComIA(telefone, pushName);

    await pool.query(
      `INSERT INTO mensagens (telefone, role, texto) VALUES ($1, 'model', $2)`,
      [telefone, respostaIA]
    );

    await axios.post(
      `${EVOLUTION_API_URL}/message/sendText/${INSTANCIA}`,
      { number: telefone, text: respostaIA },
      { headers: headersEvo }
    );
  } catch (erro) {
    console.error('Erro no webhook:', erro.response?.data || erro.message);
  }
});

// ==========================================
// 5. ROTAS DO PAINEL ADMINISTRATIVO
// ==========================================
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
  const { bot_pausado } = req.body;
  await pool.query(
    'UPDATE leads SET bot_pausado = $1, motivo_pausa = CASE WHEN $1 = false THEN NULL ELSE motivo_pausa END WHERE id = $2',
    [bot_pausado, req.params.id]
  );
  res.json({ ok: true });
});

app.get('/api/leads/:telefone/mensagens', autenticar, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT role, texto, criado_em FROM mensagens WHERE telefone = $1 ORDER BY id ASC LIMIT 50',
    [req.params.telefone]
  );
  res.json(rows);
});

app.get('/api/config', autenticar, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM configuracoes WHERE id = 1');
  res.json(rows[0]);
});

app.put('/api/config', autenticar, async (req, res) => {
  const { nome_lavanderia, endereco, horario, tabela_precos, regras_extras, bot_ativo_global } = req.body;
  await pool.query(
    `UPDATE configuracoes
     SET nome_lavanderia=$1, endereco=$2, horario=$3, tabela_precos=$4, regras_extras=$5, bot_ativo_global=$6
     WHERE id = 1`,
    [nome_lavanderia, endereco, horario, tabela_precos, regras_extras, bot_ativo_global]
  );
  res.json({ ok: true });
});

// ==========================================
// 6. ROTAS DE CONEXÃO DO WHATSAPP NO PAINEL
// ==========================================
app.get('/api/whatsapp/status', autenticar, async (req, res) => {
  try {
    const { data } = await axios.get(`${EVOLUTION_API_URL}/instance/connectionState/${INSTANCIA}`, { headers: headersEvo });
    const state = data?.instance?.state || 'close';
    res.json({ conectado: state === 'open', status: state });
  } catch {
    res.json({ conectado: false, status: 'desconectado' });
  }
});

app.get('/api/whatsapp/conectar', autenticar, async (req, res) => {
  try {
    const { numero } = req.query;
    const url = numero
      ? `${EVOLUTION_API_URL}/instance/connect/${INSTANCIA}?number=${numero.replace(/\D/g, '')}`
      : `${EVOLUTION_API_URL}/instance/connect/${INSTANCIA}`;

    const { data } = await axios.get(url, { headers: headersEvo });
    res.json({ qrcode: data.base64 || null, pairingCode: data.pairingCode || null });
  } catch (erro) {
    res.status(500).json({ erro: 'Erro ao gerar conexão. Verifique se a instância existe na Evolution API.' });
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

// Inicia banco e servidor
iniciarBanco()
  .then(() => {
    app.listen(PORT, () => console.log(`Sistema rodando na porta ${PORT}`));
  })
  .catch((err) => {
    console.error('Falha ao conectar no banco:', err);
    process.exit(1);
  });
