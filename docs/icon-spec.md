# onchato - ikona: zadanie dla Claude Code

## Cel
Wygeneruj komplet plikow ikony onchato (P2P E2EE chat, tryb whisper) z jednego
zrodla SVG. Zero recznego rysowania poza podana geometria. Wszystko ma byc
odtwarzalne skryptem.

## Znak
Dwie pionowe kreski. Lewa przerwana (usta mowiacego). Prawa z jednym
wygieciem do wewnatrz (ucho sluchajacego). Nic wiecej: brak fal, kropek,
cieni, gradientow, tekstu w znaku.

Geometria master, przestrzen 100x100, stroke-linecap round, fill none:

    stroke-width 8
    M36 14 V44                         lewa gora
    M36 62 V92                         lewa dol
    M64 14 V38 C52 44 52 62 64 68 V92  prawa z uchem

Wariant maly (dla 16 i 32 px), ta sama przestrzen 100x100:

    stroke-width 10
    M36 12 V40
    M36 66 V94
    M64 12 V36 C50 42 50 64 64 70 V94

Zasada: w renderze 16 px przerwa musi miec >= 3 px, kreska >= 1.5 px.
Nie skaluj masteru do 16 px, uzyj wariantu malego.

## Kolory
    czarny  #0A0A0A   (tlo kafelka, wersja ciemna)
    zielony #TODO     (znak na czarnym; podac finalny hex przed startem,
                       roboczo #2EE59D)
    bialy   #FFFFFF   (znak na zielonym tle, wersja jasna)

Warianty kolorystyczne:
    A  zielony znak na czarnym tle      (glowny kafelek)
    B  czarny znak na zielonym tle      (alternatywny kafelek, marketing)
    C  znak monochromatyczny, currentColor, bez tla (UI, favicon SVG,
       Android notification, macOS template)

## Pliki do wygenerowania

    assets/icon/src/
      mark.svg              master, 100x100, wariant C (currentColor)
      mark-small.svg        wariant maly, 100x100, currentColor
      tile-dark.svg         512x512, rx 22% (112 px), wariant A,
                            znak na 70% wysokosci, wysrodkowany
      tile-green.svg        jak wyzej, wariant B

    assets/icon/web/
      favicon.svg           mark-small, currentColor, media query
                            prefers-color-scheme: znak czarny/zielony
      favicon-16.png        z mark-small, wariant A, tlo czarne
      favicon-32.png        j.w.
      favicon.ico           16+32+48 spakowane
      apple-touch-icon.png  180x180, tile-dark, bez alfa
      icon-192.png          tile-dark
      icon-512.png          tile-dark
      icon-512-maskable.png tile-dark, znak zmniejszony do 60% wysokosci
                            (safe zone 80% srednicy)
      site.webmanifest      wpisy dla 192, 512, 512 maskable

    assets/icon/android/
      ic_launcher_foreground.svg   108x108 dp, znak w safe zone 66 dp,
                                   zielony
      ic_launcher_background.svg   108x108 dp, czarne wypelnienie
      ic_launcher_monochrome.svg   108x108 dp, znak czarny (Android 13
                                   themed icon)
      ic_notification.svg          24x24 dp, mark-small, bialy, alfa

    assets/icon/ios/
      AppIcon-1024.png     tile-dark bez alfa, bez zaokraglen (iOS nakladamaske)

    assets/icon/lockup/
      lockup-horizontal.svg  znak (mark) + tekst "onchato", odstep 0.6
                             wysokosci znaku, tekst jako sciezki (nie font)
      lockup-dark.svg        wariant A
      lockup-light.svg       czarny znak i tekst na przezroczystym

## Skrypt
    scripts/build-icons.sh (albo .mjs z sharp)
    - zrodlo: assets/icon/src/*.svg, nic nie jest edytowane recznie
    - rasteryzacja: rsvg-convert lub sharp; nie ImageMagick z domyslnym
      antialiasingiem
    - PNG: sRGB, 8 bit, bez metadanych, zoptymalizowane (oxipng lub
      pngquant nie, bo gubi kolor; tylko bezstratnie)
    - ico: png-to-ico lub icotool
    - komenda `make icons` odtwarza wszystko od zera

## Kryteria akceptacji
    1. Render favicon-16.png: przerwa lewej kreski widoczna, ucho nie
       zlewa sie z pionem. Sprawdz przez powiekszenie x8 i dolacz PNG
       kontrolne do assets/icon/preview/.
    2. tile-dark 512 vs 48: proporcje znaku identyczne w granicach 1 px.
    3. Maskable: znak w calosci w kole o srednicy 80% kafelka.
    4. Zaden plik nie zawiera gradientow, filtrow, embedded fontow,
       ani elementow <text>.
    5. Wszystkie SVG przechodza svgo bez zmian geometrii; viewBox
       zaczyna sie od 0 0.
    6. Wygeneruj preview.html w assets/icon/preview/ pokazujacy wszystkie
       pliki obok siebie na jasnym i ciemnym tle.

## Czego nie robic
    - nie dodawac fal, kropek ani tekstu do znaku
    - nie zmieniac proporcji przerwy ani glebokosci ucha
    - nie uzywac czystego #000000 (banding na OLED przy animacji tla)
    - nie generowac ikon z fontu ani z emoji
