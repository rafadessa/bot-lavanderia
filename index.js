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

    // Captura Áudio / PTT de forma robusta
    const audioMessage = data.message?.audioMessage || data.message?.pttMessage;
    if (audioMessage) {
      tipoMidia = 'audio';
      mimeType = audioMessage.mimetype || 'audio/ogg; codecs=opus';
      textoMensagem = '[Áudio do cliente]';

      try {
        const resMidia = await axios.post(
          `${EVOLUTION_API_URL}/chat/getBase64FromMedia/${INSTANCIA}`,
          { message: data },
          { headers: headersEvo }
        );
        const b64 = resMidia.data?.base64;
        if (b64) {
          bufferMidia = Buffer.from(b64.includes(',') ? b64.split(',')[1] : b64, 'base64');
        }
      } catch (e) {
        console.log('Aviso ao buscar mídia via Evolution:', e.message);
      }
    }

    // Captura Imagem
    const imageMessage = data.message?.imageMessage;
    if (imageMessage) {
      tipoMidia = 'image';
      mimeType = imageMessage.mimetype || 'image/jpeg';
      textoMensagem = imageMessage.caption || '[Imagem do cliente]';

      try {
        const resMidia = await axios.post(
          `${EVOLUTION_API_URL}/chat/getBase64FromMedia/${INSTANCIA}`,
          { message: data },
          { headers: headersEvo }
        );
        const b64 = resMidia.data?.base64;
        if (b64) {
          bufferMidia = Buffer.from(b64.includes(',') ? b64.split(',')[1] : b64, 'base64');
        }
      } catch (e) {
        console.log('Aviso ao buscar imagem via Evolution:', e.message);
      }
    }

    // Se o cliente mandou áudio mas por algum motivo o buffer veio vazio, criamos um texto padrão para não travar
    if (tipoMidia === 'audio' && (!bufferMidia || bufferMidia.length === 0)) {
      textoMensagem = 'O cliente enviou um áudio, mas não consegui converter o arquivo. Peça educadamente para ele digitar a dúvida.';
      tipoMidia = 'text';
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
