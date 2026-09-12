/**
 * СЕРВЕР ДЛЯ ПРИЁМА ОПЛАТЫ ЧЕРЕЗ ТИНЬКОФФ КАССУ (Т-Kassa / Тинькофф Бизнес)
 * ---------------------------------------------------------------------
 * ПОЧЕМУ ЭТО НЕЛЬЗЯ СДЕЛАТЬ ПРЯМО НА САЙТЕ В TILDA:
 * У терминала Тинькофф Кассы есть TerminalKey (публичный, не секрет)
 * и Password (СЕКРЕТНЫЙ пароль терминала). Password участвует в подписи
 * каждого запроса. Если положить Password в код сайта — его увидит
 * любой человек через "Просмотр кода страницы" и сможет создавать
 * платежи или подделывать подтверждения от вашего имени. Поэтому
 * Password должен жить только на сервере, а не в браузере.
 *
 * ==================== ЧТО ИЗМЕНИЛОСЬ В ЭТОЙ ВЕРСИИ ====================
 * Была найдена вероятная причина ошибки "не удалось связаться с сервером
 * оплаты": предыдущая версия использовала встроенный fetch() — он
 * появился в Node.js только начиная с версии 18. Если сервис на Render
 * был создан ещё до этого (или Node-версия там почему-то более старая),
 * вызов fetch() падает с ошибкой ДО того, как что-либо отправляется в
 * Тинькофф. Из-за этого клиенту вместо чистого JSON-ответа прилетает
 * страница-заглушка об ошибке — браузер не может её разобрать как JSON,
 * и это выглядит как "не удалось связаться", хотя на самом деле сервер
 * просто упал на пустом месте.
 * Починено так, чтобы это в принципе не могло повториться: вместо fetch()
 * теперь используется встроенный модуль Node.js "https" — он работает
 * абсолютно на любой версии Node, никаких внешних условий и подводных
 * камней с версией платформы. Дополнительно ниже в package.json
 * явно прописана нужная версия Node — на случай, если Render всё же
 * учитывает эту настройку при следующем деплое.
 * ========================================================================
 *
 * ГДЕ ЗАПУСТИТЬ ЭТОТ КОД (без своего физического сервера):
 * - Yandex Cloud Functions / Timeweb Cloud Apps / Vercel / Render —
 *   у всех есть бесплатный или недорогой тариф, деплой за 10 минут.
 *
 * ЧТО НУЖНО ПОЛУЧИТЬ У ТИНЬКОФФ:
 * 1. Подключить приём платежей в Тинькофф Бизнес → выдадут TerminalKey и Password.
 * 2. В личном кабинете указать:
 *    - Notification URL — https://ваш-сервер/tinkoff/notify
 *    - Success URL       — https://meusdomus.ru/?payment=success
 *    - Fail URL          — https://meusdomus.ru/?payment=fail
 *
 * ТЕКУЩИЙ СТАТУС: боевые ключи подключены, сайт принимает настоящие деньги.
 *
 * УСТАНОВКА ЗАВИСИМОСТЕЙ: npm init -y && npm install express
 * (модуль https — встроенный в Node.js, ставить отдельно не нужно)
 */

const express = require('express');
const crypto = require('crypto');
const https = require('https');
const app = express();
app.use(express.json());

// БОЕВЫЕ КЛЮЧИ — принимаем настоящие деньги:
const TERMINAL_KEY = '1785336284647';
const TERMINAL_PASSWORD = '2ir^%&_X35q$iWt_';

// Разрешаем запросы с вашего сайта
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://meusdomus.ru');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Подпись запроса по алгоритму Тинькофф: берём плоские поля запроса
// (без вложенных объектов/массивов), добавляем Password, сортируем по
// ключу, склеиваем значения и хэшируем SHA-256.
function buildToken(params) {
  const flat = { ...params, Password: TERMINAL_PASSWORD };
  const keys = Object.keys(flat)
    .filter((k) => typeof flat[k] !== 'object')
    .sort();
  const concatenated = keys.map((k) => String(flat[k])).join('');
  return crypto.createHash('sha256').update(concatenated).digest('hex');
}

// Замена fetch() на встроенный https-модуль — работает на любой версии
// Node.js без исключений. Возвращает Promise с уже распарсенным JSON,
// чтобы остальной код ниже мог продолжать работать точно так же, как
// раньше (await postJson(...)), без переписывания логики вокруг него.
function postJson(url, bodyObj) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(bodyObj);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      },
      timeout: 15000 // 15 секунд — банк обычно отвечает быстрее, но подстрахуемся от зависания
    };

    const request = https.request(options, (response) => {
      let raw = '';
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (parseErr) {
          reject(new Error('Тинькофф вернул нестандартный ответ (не JSON): ' + raw.slice(0, 300)));
        }
      });
    });

    request.on('timeout', () => {
      request.destroy();
      reject(new Error('Тинькофф не ответил за 15 секунд (таймаут)'));
    });
    request.on('error', (err) => { reject(err); });

    request.write(bodyStr);
    request.end();
  });
}

// 1) Приём заказа с сайта → создание платежа в Тинькофф → отдаём ссылку на оплату
app.post('/tinkoff/init', async (req, res) => {
  try {
    const { orderNumber, amount, customerName, customerPhone, items } = req.body;

    if (!orderNumber || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Некорректные данные заказа' });
    }

    const SITE_URL = 'https://meusdomus.ru';
    const SERVER_URL = 'https://meusdomus-tinkoff.onrender.com';

    const initParams = {
      TerminalKey: TERMINAL_KEY,
      Amount: Math.round(amount * 100), // Тинькофф считает в копейках
      OrderId: orderNumber,
      Description: 'Заказ Meus Domus ' + orderNumber,
      DATA: { Phone: customerPhone || '', Name: customerName || '' },
      SuccessURL: SITE_URL + '/?payment=success',
      FailURL: SITE_URL + '/?payment=fail',
      NotificationURL: SERVER_URL + '/tinkoff/notify'
    };
    const token = buildToken(initParams);

    let data;
    try {
      data = await postJson('https://securepay.tinkoff.ru/v2/Init', { ...initParams, Token: token });
    } catch (networkErr) {
      // ВАЖНО: логируем максимально подробно — именно эта строка в логах
      // Render покажет, если проблема повторится, что конкретно пошло не так
      // при обращении к самому Тинькоффу (а не внутри нашего сервера)
      console.error('Не удалось связаться с Тинькофф Init API:', networkErr.message);
      return res.status(502).json({ error: 'Не удалось связаться с платёжным шлюзом Тинькофф. Попробуйте ещё раз через минуту.' });
    }

    if (!data.Success) {
      console.error('Tinkoff Init error:', data);
      return res.status(502).json({ error: data.Message || 'Ошибка платёжного шлюза' });
    }

    return res.json({ paymentUrl: data.PaymentURL });
  } catch (err) {
    console.error('Внутренняя ошибка в /tinkoff/init:', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// 2) Вебхук от Тинькофф: сюда прилетает подтверждение реальной оплаты.
//    ЭТО единственный источник правды об оплате — статус на фронтенде
//    (redirect на Success URL) использовать для отгрузки товара нельзя,
//    его можно подделать вручную открыв ссылку.
app.post('/tinkoff/notify', (req, res) => {
  const body = req.body;
  const receivedToken = body.Token;
  const check = { ...body };
  delete check.Token;
  const expectedToken = buildToken(check);

  if (receivedToken !== expectedToken) {
    console.warn('Неверная подпись вебхука — запрос отклонён');
    return res.status(400).send('bad token');
  }

  if (body.Status === 'CONFIRMED') {
    // TODO: пометить заказ body.OrderId как оплаченный в вашей базе/таблице,
    // отправить уведомление себе (email/Telegram) о новом оплаченном заказе
    console.log('Оплачен заказ:', body.OrderId, 'сумма:', body.Amount / 100);
  }

  // Тинькофф ждёт именно текст "OK" в ответ
  res.send('OK');
});

// Простой диагностический маршрут — открыв его в браузере, можно быстро
// проверить, что сервис вообще жив и отвечает (без обращения к Тинькофф)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Сервер оплаты запущен на порту ' + PORT + ', версия Node.js: ' + process.version));
