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
        'Todos os dias das 07h às 22h (Equipe presencial em horário comercial)',
        '- Lavar OU Secar (Máquina Normal): R$ 17,99 por ciclo\n- Lavar OU Secar (Máquina Big - edredons/grandes volumes): R$ 39,99 por ciclo\n- Serviço da Equipe (+ R$ 7,00): nossa equipe coloca na máquina, faz os ciclos, dobra, embala e você só vem retirar!',
        'Produtos profissionais (sabão e amaciante) já inclusos automaticamente nas máquinas. Aceitamos PIX e Cartão. Sempre ofereça o adicional de +R$ 7,00 para clientes sem tempo de esperar.'
      ]
    );
  }

  const { rows: faqRows } = await pool.query('SELECT id FROM faq LIMIT 1');
  if (faqRows.length === 0) {
    const faqsIniciais = [
      ['Preciso levar sabão ou amaciante?', 'Não precisa! Nossas máquinas dosam automaticamente sabão e amaciante profissionais de alta qualidade, já inclusos no valor do ciclo.'],
      ['Quanto tempo demora cada ciclo?', 'A lavagem leva em média 30 a 35 minutos e a secagem cerca de 45 minutos.'],
      ['O que cabe na Máquina Normal vs Big?', 'A Máquina Normal (R$ 17,99) comporta cerca de 1 cesto de roupas do dia a dia (aprox. 10kg). A Máquina Big (R$ 39,99) é ideal para edredons de casal/Queen/King, cobertores pesados ou grandes volumes.'],
      ['Como funciona o serviço de +R$ 7,00?', 'Por apenas +R$ 7,00 além dos ciclos, você deixa as roupas com nossa equipe. Nós colocamos na máquina, acompanhamos a lavagem/secagem, dobramos e embalamos tudo. Você só passa para retirar!'],
      ['Formas de pagamento', 'Aceitamos PIX, Cartão de Crédito e Cartão de Débito direto no totem ou no balcão.']
    ];
    for (const [titulo, conteudo] of faqsIniciais) {
      await pool.query('INSERT INTO faq (titulo, conteudo) VALUES ($1, $2)', [titulo, conteudo]);
    }
  }

  console.log('Banco de dados pronto!');
}

// ==========================================
// 2. AUTENTICAÇÃO DO PAINEL
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
// 3. INTELIGÊNCIA ARTIFICIAL (GEMINI + FAQ + TOOLS)
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
        name: 'registrar_pedido',
        description: 'Registra um pedido ou agendamento (ex: Serviço da Equipe +R$ 7,00 ou reserva/entrega) quando o cliente informar nome, peças e horário/observação.',
        parameters: {
          type: 'OBJECT',
          properties: {
            nome: { type: 'STRING', description: 'Nome do cliente' },
            endereco: { type: 'STRING', description: 'Observação ou endereço (colocar "Retirada na loja" se for deixar no balcão)' },
            pecas: { type: 'STRING', description: 'Peças ou tipo de serviço (ex: 1 cesto + Serviço Equipe R$ 7, ou 1 Edredom Big)' },
            turno: { type: 'STRING', description: 'Quando o cliente vai deixar/retirar (ex: Hoje à tarde, Amanhã de manhã)' }
          },
          required: ['nome', 'endereco', 'pecas', 'turno']
        }
      },
      {
        name: 'chamar_atendente_humano',
        description: 'Pausa o robô e chama um humano em caso de reclamação, problema na máquina, roupa manchada ou dúvida que não está na base de conhecimento.',
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

  const { rows: faqRows } = await pool.query('SELECT titulo, conteudo FROM faq ORDER BY id ASC');
  const textoFaq = faqRows.map((f) => `- ${f.titulo}: ${f.conteudo}`).join('\n');

  const { rows: msgRows } = await pool.query(
    `SELECT role, texto FROM (
       SELECT id, role, texto FROM mensagens WHERE telefone = $1 ORDER BY id DESC LIMIT 12
     ) sub ORDER BY id ASC`,
    [telefone]
  );

  const systemPrompt = `
Você é a atendente virtual da ${cfg.nome_lavanderia} no WhatsApp.
Atenda de forma simpática, prestativa, natural e direta (mensagens curtas de WhatsApp, fáceis de ler no celular).

DADOS DA LOJA:
- Endereço: ${cfg.endereco}
- Horário: ${cfg.horario}
- Regras gerais: ${cfg.regras_extras}

TABELA DE PREÇOS:
${cfg.tabela_precos}

BASE DE CONHECIMENTO (DÚVIDAS FREQUENTES):
${textoFaq}

REGRAS OBRIGATÓRIAS:
1. Use sempre a Tabela de Preços e a Base de Conhecimento acima para responder. Nunca invente preços ou regras.
2. Se o cliente quiser deixar roupas para o Serviço da Equipe (+R$ 7,00) ou agendar atendimento, confirme: Nome, quais peças vai trazer e quando pretende passar, e chame a função "registrar_pedido".
3. Se o cliente relatar problema técnico na máquina, reclamação ou fizer uma pergunta muito específica que não está nas informações acima, chame "chamar_atendente_humano" e avise que a equipe vai responder em seguida.
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

    if (name === 'registrar_pedido') {
      await pool.query(
        `INSERT INTO agendamentos (telefone, nome, endereco, pecas, turno, status) VALUES ($1, $2, $3, $4, $5, 'Aguardando')`,
        [telefone, args.nome, args.endereco, args.pecas, args.turno]
      );
      await pool.query(
        `UPDATE leads SET nome = $1, endereco = $2 WHERE telefone = $3`,
        [args.nome, args.endereco, telefone]
      );
      resultadoFuncao = { sucesso: true, mensagem: 'Pedido registrado no painel da loja com sucesso.' };
    } else if (name === 'chamar_atendente_humano') {
      await pool.query(
        `UPDATE leads SET bot_pausado = true, motivo_pausa = $1 WHERE telefone = $2`,
        [args.motivo, telefone]
      );
      resultadoFuncao = { sucesso: true, mensagem: 'Atendente humano notificado e bot pausado.' };
    }

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

  return (
    resposta.data.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text ||
    'Desculpe, tive uma instabilidade aqui. Pode repetir?'
  );
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

    await pool.query(
      `INSERT INTO leads (telefone, nome, ultima_mensagem, atualizado_em)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (telefone)
       DO UPDATE SET ultima_mensagem = EXCLUDED.ultima_mensagem, atualizado_em = NOW()`,
      [telefone, pushName, texto]
    );

    await pool.query(
      `INSERT INTO mensagens (telefone, role, texto) VALUES ($1, 'user', $2)`,
      [telefone, texto]
    );

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
// 5. ROTAS DO PAINEL (RESUMO, PEDIDOS, LEADS, FAQ, CONFIG)
// ==========================================
app.get('/api/resumo', autenticar, async (req, res) => {
  const leads = await pool.query('SELECT COUNT(*) FROM leads');
  const pausados = await pool.query('SELECT COUNT(*) FROM leads WHERE bot_pausado = true');
  const pedidosAtivos = await pool.query("SELECT COUNT(*) FROM agendamentos WHERE status NOT IN ('Entregue', 'Cancelado')");
  res.json({
    totalLeads: Number(leads.rows[0].count),
    aguardandoHumano: Number(pausados.rows[0].count),
    pedidosAtivos: Number(pedidosAtivos.rows[0].count)
  });
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

// ROTAS DE FAQ (BASE DE CONHECIMENTO)
app.get('/api/faq', autenticar, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM faq ORDER BY id DESC');
  res.json(rows);
});

app.post('/api/faq', autenticar, async (req, res) => {
  const { titulo, conteudo } = req.body;
  if (!titulo || !conteudo) return res.status(400).json({ erro: 'Preencha título e resposta.' });
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
    `UPDATE configuracoes
     SET nome_lavanderia=$1, endereco=$2, horario=$3, tabela_precos=$4, regras_extras=$5, bot_ativo_global=$6
     WHERE id = 1`,
    [nome_lavanderia, endereco, horario, tabela_precos, regras_extras, bot_ativo_global]
  );
  res.json({ ok: true });
});

// ==========================================
// 6. ROTAS DE CONEXÃO DO WHATSAPP
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
  } catch {
    res.status(500).json({ erro: 'Erro ao gerar conexão. Verifique a instância na Evolution API.' });
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

iniciarBanco()
  .then(() => app.listen(PORT, () => console.log(`Sistema rodando na porta ${PORT}`)))
  .catch((err) => {
    console.error('Falha ao conectar no banco:', err);
    process.exit(1);
  });
