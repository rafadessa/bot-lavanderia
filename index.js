import express from 'express';
import axios from 'axios';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;

// Memória temporária das conversas (guarda as últimas 10 mensagens por cliente)
const historico = new Map();

// EDITE AQUI AS INFORMAÇÕES DA LAVANDERIA DO SEU CLIENTE
const PROMPT_LAVANDERIA = `
Você é a atendente virtual da Lavanderia [NOME DA LAVANDERIA].
Atenda os clientes no WhatsApp de forma simpática, educada, natural e direta (respostas curtas, estilo WhatsApp).

INFORMAÇÕES DA LAVANDERIA:
- Endereço: [Rua Exemplo, 123 - Bairro]
- Horário de funcionamento: Segunda a Sexta das 08h às 18h | Sábado das 08h às 12h.
- Prazo padrão de entrega: 48 horas úteis (peças delicadas ou tapetes: até 5 dias úteis).
- Coleta e entrega (Delivery): Taxa de R$ 10,00 (grátis para pedidos acima de R$ 80,00).
- Formas de pagamento: PIX, Cartão de Crédito/Débito e Dinheiro na entrega.

TABELA DE PREÇOS:
- Camisa social (lavar e passar): R$ 15,00
- Calça jeans/social: R$ 18,00
- Terno completo: R$ 45,00
- Edredom solteiro: R$ 35,00
- Edredom casal / Queen: R$ 45,00
- Edredom King: R$ 55,00
- Cesto de roupa do dia a dia (por quilo): R$ 22,00/kg
- Tênis: R$ 30,00

REGRAS OBRIGATÓRIAS:
1. Nunca invente preços ou serviços que não estão na lista acima. Se o cliente perguntar por uma peça que não está na tabela (ex: vestido de noiva, cortina grande, tapete persa), diga que vai confirmar o valor exato com a equipe e já retorna.
2. Se o cliente quiser agendar coleta, peça: Nome, Endereço completo, quais peças vai enviar e o melhor turno (manhã ou tarde).
3. Se o cliente reclamar de alguma peça danificada ou manchada, peça desculpas e diga que vai transferir imediatamente para o gerente.
4. Use poucos emojis e nunca mande textos gigantes.
`;

async function perguntarParaIA(numero, mensagemCliente) {
  if (!historico.has(numero)) {
    historico.set(numero, []);
  }

  const conversa = historico.get(numero);
  conversa.push({ role: 'user', parts: [{ text: mensagemCliente }] });

  // Mantém apenas as últimas 10 mensagens para economizar tokens
  if (conversa.length > 10) {
    conversa.shift();
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

  const response = await axios.post(url, {
    system_instruction: {
      parts: [{ text: PROMPT_LAVANDERIA }]
    },
    contents: conversa
  });

  const resposta = response.data.candidates[0].content.parts[0].text;
  conversa.push({ role: 'model', parts: [{ text: resposta }] });

  return resposta;
}

async function enviarWhatsApp(instancia, numero, texto) {
  const url = `${EVOLUTION_API_URL}/message/sendText/${instancia}`;
  await axios.post(
    url,
    {
      number: numero,
      text: texto
    },
    {
      headers: {
        apikey: EVOLUTION_API_KEY,
        'Content-Type': 'application/json'
      }
    }
  );
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Responde rápido para a Evolution não reenviar

  try {
    const { instance, data } = req.body;
    if (!data || !data.key) return;

    const fromMe = data.key.fromMe;
    const remoteJid = data.key.remoteJid;

    // Ignora mensagens enviadas pelo próprio número e mensagens de grupos
    if (fromMe || !remoteJid || remoteJid.includes('@g.us')) return;

    const textoRecebido =
      data.message?.conversation ||
      data.message?.extendedTextMessage?.text;

    if (!textoRecebido) return;

    const respostaIA = await perguntarParaIA(remoteJid, textoRecebido);
    await enviarWhatsApp(instance, remoteJid, respostaIA);
  } catch (erro) {
    console.error('Erro ao processar mensagem:', erro.response?.data || erro.message);
  }
});

app.get('/', (req, res) => {
  res.send('Bot da Lavanderia rodando!');
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
