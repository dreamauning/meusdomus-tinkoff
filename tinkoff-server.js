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
 * Tilda — статичный конструктор страниц, сервера для секретов у неё нет.
 * Значит нужен отдельный, пусть и совсем маленький, сервер.
 *
 * ГДЕ ЗАПУСТИТЬ ЭТОТ КОД (без своего физического сервера):
 * - Yandex Cloud Functions / Timeweb Cloud Apps / Vercel / Render —
 *   у всех есть бесплatный или недорогой тариф, деплой за 10 минут.
 * - Правильный сервер задаст любой backend-разработчик за пару часов —
 *   ниже отправная точка, а не готовое "включил и работает" решение:
 *   перед боевым запуском протестируйте оплату в песочнице Тинькофф
 *   и проверьте, что вебхук (Notification) действительно приходит.
 *
 * ЧТО НУЖНО ПОЛУЧИТЬ У ТИНЬКОФФ:
 * 1. Подключить приём платежей в Тинькофф Бизнес → выдадут TerminalKey и Password.
 * 2. В личном кабинете указать:
 *    - Notification URL — https://ваш-сервер/tinkoff/notify
 *    - Success URL       — https://meusdomus.ru/?payment=success
 *    - Fail URL          — https://meusdomus.ru/?payment=fail
 *
 * ТЕКУЩИЙ СТАТУС: тестовый платёж успешно пройден, Тинькофф выдал БОЕВЫЕ
 * ключи (см. ниже) — сайт принимает настоящие деньги. Реквизиты для
 * Notification/Success/Fail URL (см. выше) уже настроены прямо в коде
 * (см. функцию ниже, где формируется запрос Init) — менять в личном
 * кабинете Тинькофф ничего дополнительно не нужно.
 *
 * УСТАНОВКА ЗАВИСИМОСТЕЙ: npm init -y && npm install express
 */

const express = require('express');
const crypto = require('crypto');
const app = express();
app.use(express.json());

// БОЕВЫЕ КЛЮЧИ — тестовый платёж пройден, принимаем настоящие деньги:
const TERMINAL_KEY = '1785336284647';
const TERMINAL_PASSWORD = '2ir^%&_X35q$iWt_';

// Разрешаем запросы с вашего сайта (замените на реальный домен перед запуском)
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

// 1) Приём заказа с сайта → создание платежа в Тинькофф → отдаём ссылку на оплату
app.post('/tinkoff/init', async (req, res) => {
  try {
    const { orderNumber, amount, customerName, customerPhone, items } = req.body;

    if (!orderNumber || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Некорректные данные заказа' });
    }

    // ВАЖНО: явно передаём SuccessURL/FailURL/NotificationURL прямо в запросе —
    // так сайт полностью контролирует, куда вернуть покупателя, и не зависит
    // от того, правильно ли эти адреса настроены (или настроены ли вообще)
    // в личном кабинете Тинькофф. Согласно документации банка, если эти
    // параметры переданы в запросе — используются именно они, а не настройки
    // терминала.
    const SITE_URL = 'https://meusdomus.ru';
    const SERVER_URL = 'https://meusdomus-tinkoff.onrender.com'; // адрес ЭТОГО сервера

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

    const response = await fetch('https://securepay.tinkoff.ru/v2/Init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...initParams, Token: token })
    });
    const data = await response.json();

    if (!data.Success) {
      console.error('Tinkoff Init error:', data);
      return res.status(502).json({ error: data.Message || 'Ошибка платёжного шлюза' });
    }

    return res.json({ paymentUrl: data.PaymentURL });
  } catch (err) {
    console.error(err);
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Сервер оплаты запущен на порту ' + PORT));
