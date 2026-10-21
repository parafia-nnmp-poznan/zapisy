# Zapisy liturgiczne NNMP w Poznaniu

Aplikacja do zapisów na posługi liturgiczne (czytania, psalm, modlitwa
powszechna, procesja z darami) w Parafii Nawiedzenia NMP w Poznaniu.

- Strona: statyczna PWA (GitHub Pages).
- Dane: Arkusz Google + Google Apps Script (poza tym repozytorium).

## Prawa autorskie i licencja

© 2026 [IMIĘ I NAZWISKO AUTORA]. Wszelkie prawa zastrzeżone.

Kod jest publiczny wyłącznie ze względu na hosting na GitHub Pages. **Nie jest to
oprogramowanie open source.** Parafia Nawiedzenia NMP w Poznaniu ma
nieodpłatną licencję na używanie aplikacji; wszelkie inne wykorzystanie
(kopiowanie, własne instancje, modyfikacje, publikacja) wymaga zgody autora.
Szczegóły: [LICENSE](LICENSE). Logo i nazwa Parafii nie są objęte licencją.

Kontakt: [ADRES E-MAIL AUTORA]

## Dla osoby utrzymującej aplikację

- Nie umieszczaj w repozytorium sekretów (PIN, adres e-mail do zgłoszeń, klucze) –
  są wyłącznie w Apps Script (Właściwości skryptu / kod serwera).
- Plik `config.js` zawiera tylko publiczny adres wdrożenia `/exec`.
- Po każdej zmianie plików zwiększ `APP_VERSION` w `app.js` i nazwę cache w `sw.js`.
