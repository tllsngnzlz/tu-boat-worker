# TU Bootshaus Buchungskalender

Ein kleines Hobbyprojekt, das freie Bootsbuchungen für Segelboote an der TU Berlin einsammelt und als übersichtlichen Kalender darstellt.

## Architektur

Das Projekt besteht aus zwei Teilen:

- **Frontend**: statische Website mit Kalenderansicht im Ordner /docs
- **Worker**: crawlt die TU-Seiten, findet aktuelle Buchungslinks und liefert normalisierte Slot-Daten als JSON

## Ablauf

1. Der Worker startet auf der Bootshaus-Seite.
2. Er findet den Link zu **Bootsverleih**.
3. Von dort folgt er zur **Bootsübersicht / Buchung**.
4. Er sammelt alle aktuellen Bootskategorie-Seiten.
5. Pro Kategorie findet er die saisonalen Buchungslinks.
6. Er lädt die finalen `anmeldung.fcgi`-Seiten.
7. Er extrahiert verfügbare Slots.
8. Das Frontend lädt diese Daten und rendert den Kalender.

## Features

- Stellt freie Buchungen dar
- Aktualisiert alle 5 Minuten
- 7-Tage-Kalender mit Blätterfunktion
- Klick auf Slot öffnet die TU-Buchung in neuem Tab

## ToDo

- Schöneres Layout
- Caching überarbeiten
- Code aufräumen
- How To deploy/run locally

## Lizenz

GPL 3 Lizenz