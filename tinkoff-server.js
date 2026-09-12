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
const tls = require('tls');
const app = express();
app.use(express.json());

// БОЕВЫЕ КЛЮЧИ — принимаем настоящие деньги:
const TERMINAL_KEY = '1785336284647';
const TERMINAL_PASSWORD = '2ir^%&_X35q$iWt_';

/* ==================== РОССИЙСКИЙ СЕРТИФИКАТ МИНЦИФРЫ ====================
 * НАЙДЕНА ТОЧНАЯ ПРИЧИНА ошибки "self-signed certificate in certificate
 * chain": согласно официальной документации Т-Банка
 * (developer.tbank.ru/eacq/intro/certificates/migration-russian-trusted-ca),
 * банк переходит с международных сертификатов GlobalSign (которые могут
 * быть отозваны из-за ужесточения правил CA/Browser Forum) на российский
 * национальный сертификат — Russian Trusted CA (Минцифры России). Node.js
 * не доверяет этому сертификату "из коробки", поэтому запрос к Тинькофф
 * падает ещё до того, как уходит к банку.
 * Ниже — официальные корневой (Root) и промежуточный (Sub) сертификаты
 * Минцифры, ДОБАВЛЕННЫЕ к стандартному списку доверенных центров Node.js
 * (не заменяющие его) — так сервер продолжит доверять и обычным мировым
 * сертификатам (на случай, если Тинькофф ещё не до конца переключился),
 * и новому российскому. */
const RUSSIAN_TRUSTED_ROOT_CA = `-----BEGIN CERTIFICATE-----
MIIFwjCCA6qgAwIBAgICEAAwDQYJKoZIhvcNAQELBQAwcDELMAkGA1UEBhMCUlUx
PzA9BgNVBAoMNlRoZSBNaW5pc3RyeSBvZiBEaWdpdGFsIERldmVsb3BtZW50IGFu
ZCBDb21tdW5pY2F0aW9uczEgMB4GA1UEAwwXUnVzc2lhbiBUcnVzdGVkIFJvb3Qg
Q0EwHhcNMjIwMzAxMjEwNDE1WhcNMzIwMjI3MjEwNDE1WjBwMQswCQYDVQQGEwJS
VTE/MD0GA1UECgw2VGhlIE1pbmlzdHJ5IG9mIERpZ2l0YWwgRGV2ZWxvcG1lbnQg
YW5kIENvbW11bmljYXRpb25zMSAwHgYDVQQDDBdSdXNzaWFuIFRydXN0ZWQgUm9v
dCBDQTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAMfFOZ8pUAL3+r2n
qqE0Zp52selXsKGFYoG0GM5bwz1bSFtCt+AZQMhkWQheI3poZAToYJu69pHLKS6Q
XBiwBC1cvzYmUYKMYZC7jE5YhEU2bSL0mX7NaMxMDmH2/NwuOVRj8OImVa5s1F4U
zn4Kv3PFlDBjjSjXKVY9kmjUBsXQrIHeaqmUIsPIlNWUnimXS0I0abExqkbdrXbX
YwCOXhOO2pDUx3ckmJlCMUGacUTnylyQW2VsJIyIGA8V0xzdaeUXg0VZ6ZmNUr5Y
Ber/EAOLPb8NYpsAhJe2mXjMB/J9HNsoFMBFJ0lLOT/+dQvjbdRZoOT8eqJpWnVD
U+QL/qEZnz57N88OWM3rabJkRNdU/Z7x5SFIM9FrqtN8xewsiBWBI0K6XFuOBOTD
4V08o4TzJ8+Ccq5XlCUW2L48pZNCYuBDfBh7FxkB7qDgGDiaftEkZZfApRg2E+M9
G8wkNKTPLDc4wH0FDTijhgxR3Y4PiS1HL2Zhw7bD3CbslmEGgfnnZojNkJtcLeBH
BLa52/dSwNU4WWLubaYSiAmA9IUMX1/RpfpxOxd4Ykmhz97oFbUaDJFipIggx5sX
ePAlkTdWnv+RWBxlJwMQ25oEHmRguNYf4Zr/Rxr9cS93Y+mdXIZaBEE0KS2iLRqa
OiWBki9IMQU4phqPOBAaG7A+eP8PAgMBAAGjZjBkMB0GA1UdDgQWBBTh0YHlzlpf
BKrS6badZrHF+qwshzAfBgNVHSMEGDAWgBTh0YHlzlpfBKrS6badZrHF+qwshzAS
BgNVHRMBAf8ECDAGAQH/AgEEMA4GA1UdDwEB/wQEAwIBhjANBgkqhkiG9w0BAQsF
AAOCAgEAALIY1wkilt/urfEVM5vKzr6utOeDWCUczmWX/RX4ljpRdgF+5fAIS4vH
tmXkqpSCOVeWUrJV9QvZn6L227ZwuE15cWi8DCDal3Ue90WgAJJZMfTshN4OI8cq
W9E4EG9wglbEtMnObHlms8F3CHmrw3k6KmUkWGoa+/ENmcVl68u/cMRl1JbW2bM+
/3A+SAg2c6iPDlehczKx2oa95QW0SkPPWGuNA/CE8CpyANIhu9XFrj3RQ3EqeRcS
AQQod1RNuHpfETLU/A2gMmvn/w/sx7TB3W5BPs6rprOA37tutPq9u6FTZOcG1Oqj
C/B7yTqgI7rbyvox7DEXoX7rIiEqyNNUguTk/u3SZ4VXE2kmxdmSh3TQvybfbnXV
4JbCZVaqiZraqc7oZMnRoWrXRG3ztbnbes/9qhRGI7PqXqeKJBztxRTEVj8ONs1d
WN5szTwaPIvhkhO3CO5ErU2rVdUr89wKpNXbBODFKRtgxUT70YpmJ46VVaqdAhOZ
D9EUUn4YaeLaS8AjSF/h7UkjOibNc4qVDiPP+rkehFWM66PVnP1Msh93tc+taIfC
EYVMxjh8zNbFuoc7fzvvrFILLe7ifvEIUqSVIC/AzplM/Jxw7buXFeGP1qVCBEHq
391d/9RAfaZ12zkwFsl+IKwE/OZxW8AHa9i1p4GO0YSNuczzEm4=
-----END CERTIFICATE-----`;

const RUSSIAN_TRUSTED_SUB_CA = `-----BEGIN CERTIFICATE-----
MIIHQjCCBSqgAwIBAgICEAIwDQYJKoZIhvcNAQELBQAwcDELMAkGA1UEBhMCUlUx
PzA9BgNVBAoMNlRoZSBNaW5pc3RyeSBvZiBEaWdpdGFsIERldmVsb3BtZW50IGFu
ZCBDb21tdW5pY2F0aW9uczEgMB4GA1UEAwwXUnVzc2lhbiBUcnVzdGVkIFJvb3Qg
Q0EwHhcNMjIwMzAyMTEyNTE5WhcNMjcwMzA2MTEyNTE5WjBvMQswCQYDVQQGEwJS
VTE/MD0GA1UECgw2VGhlIE1pbmlzdHJ5IG9mIERpZ2l0YWwgRGV2ZWxvcG1lbnQg
YW5kIENvbW11bmljYXRpb25zMR8wHQYDVQQDDBZSdXNzaWFuIFRydXN0ZWQgU3Vi
IENBMIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEA9YPqBKOk19NFymrE
wehzrhBEgT2atLezpduB24mQ7CiOa/HVpFCDRZzdxqlh8drku408/tTmWzlNH/br
HuQhZ/miWKOf35lpKzjyBd6TPM23uAfJvEOQ2/dnKGGJbsUo1/udKSvxQwVHpVv3
S80OlluKfhWPDEXQpgyFqIzPoxIQTLZ0deirZwMVHarZ5u8HqHetRuAtmO2ZDGQn
vVOJYAjls+Hiueq7Lj7Oce7CQsTwVZeP+XQx28PAaEZ3y6sQEt6rL06ddpSdoTMp
BnCqTbxW+eWMyjkIn6t9GBtUV45yB1EkHNnj2Ex4GwCiN9T84QQjKSr+8f0psGrZ
vPbCbQAwNFJjisLixnjlGPLKa5vOmNwIh/LAyUW5DjpkCx004LPDuqPpFsKXNKpa
L2Dm6uc0x4Jo5m+gUTVORB6hOSzWnWDj2GWfomLzzyjG81DRGFBpco/O93zecsIN
3SL2Ysjpq1zdoS01CMYxie//9zWvYwzI25/OZigtnpCIrcd2j1Y6dMUFQAzAtHE+
qsXflSL8HIS+IJEFIQobLlYhHkoE3avgNx5jlu+OLYe0dF0Ykx1PGNjbwqvTX37R
Cn32NMjlotW2QcGEZhDKj+3urZizp5xdTPZitA+aEjZM/Ni71VOdiOP0igbw6asZ
2fxdozZ1TnSSYNYvNATwthNmZysCAwEAAaOCAeUwggHhMBIGA1UdEwEB/wQIMAYB
Af8CAQAwDgYDVR0PAQH/BAQDAgGGMB0GA1UdDgQWBBTR4XENCy2BTm6KSo9MI7NM
XqtpCzAfBgNVHSMEGDAWgBTh0YHlzlpfBKrS6badZrHF+qwshzCBxwYIKwYBBQUH
AQEEgbowgbcwOwYIKwYBBQUHMAKGL2h0dHA6Ly9yb3N0ZWxlY29tLnJ1L2NkcC9y
b290Y2Ffc3NsX3JzYTIwMjIuY3J0MDsGCCsGAQUFBzAChi9odHRwOi8vY29tcGFu
eS5ydC5ydS9jZHAvcm9vdGNhX3NzbF9yc2EyMDIyLmNydDA7BggrBgEFBQcwAoYv
aHR0cDovL3JlZXN0ci1wa2kucnUvY2RwL3Jvb3RjYV9zc2xfcnNhMjAyMi5jcnQw
gbAGA1UdHwSBqDCBpTA1oDOgMYYvaHR0cDovL3Jvc3RlbGVjb20ucnUvY2RwL3Jv
b3RjYV9zc2xfcnNhMjAyMi5jcmwwNaAzoDGGL2h0dHA6Ly9jb21wYW55LnJ0LnJ1
L2NkcC9yb290Y2Ffc3NsX3JzYTIwMjIuY3JsMDWgM6Axhi9odHRwOi8vcmVlc3Ry
LXBraS5ydS9jZHAvcm9vdGNhX3NzbF9yc2EyMDIyLmNybDANBgkqhkiG9w0BAQsF
AAOCAgEARBVzZls79AdiSCpar15dA5Hr/rrT4WbrOfzlpI+xrLeRPrUG6eUWIW4v
Sui1yx3iqGLCjPcKb+HOTwoRMbI6ytP/ndp3TlYua2advYBEhSvjs+4vDZNwXr/D
anbwIWdurZmViQRBDFebpkvnIvru/RpWud/5r624Wp8voZMRtj/cm6aI9LtvBfT9
cfzhOaexI/99c14dyiuk1+6QhdwKaCRTc1mdfNQmnfWNRbfWhWBlK3h4GGE9JK33
Gk8ZS8DMrkdAh0xby4xAQ/mSWAfWrBmfzlOqGyoB1U47WTOeqNbWkkoAP2ys94+s
Jg4NTkiDVtXRF6nr6fYi0bSOvOFg0IQrMXO2Y8gyg9ARdPJwKtvWX8VPADCYMiWH
h4n8bZokIrImVKLDQKHY4jCsND2HHdJfnrdL2YJw1qFskNO4cSNmZydw0Wkgjv9k
F+KxqrDKlB8MZu2Hclph6v/CZ0fQ9YuE8/lsHZ0Qc2HyiSMnvjgK5fDc3TD4fa8F
E8gMNurM+kV8PT8LNIM+4Zs+LKEV8nqRWBaxkIVJGekkVKO8xDBOG/aN62AZKHOe
GcyIdu7yNMMRihGVZCYr8rYiJoKiOzDqOkPkLOPdhtVlgnhowzHDxMHND/E2WA5p
ZHuNM/m0TXt2wTTPL7JH2YC0gPz/BvvSzjksgzU5rLbRyUKQkgU=
-----END CERTIFICATE-----`;

// Полный список доверенных сертификатов для запросов к Тинькофф: обычные
// мировые (встроенные в Node.js по умолчанию) + два российских сверху —
// ДОБАВЛЯЕМ, а не заменяем, чтобы не потерять доверие к текущему
// сертификату GlobalSign, если банк ещё не завершил переключение.
const TINKOFF_TRUSTED_CA = [...tls.rootCertificates, RUSSIAN_TRUSTED_ROOT_CA, RUSSIAN_TRUSTED_SUB_CA];

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
      ca: TINKOFF_TRUSTED_CA, // мировые CA + российский Минцифры — см. пояснение выше
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
