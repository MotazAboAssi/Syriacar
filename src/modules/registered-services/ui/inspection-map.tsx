"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { RegisteredProvider } from "../contracts";
import { coordinates } from "../contracts";

type Props = {
  providers: RegisteredProvider[];
  userPoint: { lat: number; lng: number } | null;
  onSelect: (provider: RegisteredProvider) => void;
  onMapFailure: () => void;
  onMapReady: () => void;
};

export default function InspectionMap({ providers, userPoint, onSelect, onMapFailure, onMapReady }: Props) {
  const element = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const selectRef = useRef(onSelect);
  const failureRef = useRef(onMapFailure);
  const readyRef = useRef(onMapReady);
  selectRef.current = onSelect;
  failureRef.current = onMapFailure;
  readyRef.current = onMapReady;

  useEffect(() => {
    if (!element.current || mapRef.current) return;
    const map = L.map(element.current, { scrollWheelZoom: false, zoomControl: true }).setView([34.8, 38.5], 6);
    mapRef.current = map;
    const tiles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    });
    tiles.on("tileerror", () => failureRef.current());
    tiles.on("load", () => readyRef.current());
    tiles.addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    return () => { map.remove(); mapRef.current = null; layerRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    const bounds: L.LatLngTuple[] = [];
    for (const provider of providers) {
      const point = provider.coordinates && coordinates(provider.coordinates.lat, provider.coordinates.lng);
      if (!point) continue;
      bounds.push([point.lat, point.lng]);
      const mark = L.divIcon({
        className: "",
        html: `<span class="rs-marker${provider.suitable ? "" : " rs-marker-unsuitable"}"><span>${provider.suitable ? "م" : "ـ"}</span></span>`,
        iconSize: [44, 44],
        iconAnchor: [22, 43],
      });
      const label = `${provider.businessName}، ${provider.suitable ? "مناسب" : "غير مناسب"}`;
      const marker = L.marker([point.lat, point.lng], { icon: mark, title: label, keyboard: true })
        .addTo(layer)
        .on("click", () => selectRef.current(provider));
      const target = marker.getElement();
      if (target) {
        target.setAttribute("role", "button");
        target.setAttribute("aria-label", label);
        target.addEventListener("keydown", event => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          selectRef.current(provider);
        });
      }
    }
    if (userPoint) {
      bounds.push([userPoint.lat, userPoint.lng]);
      L.circleMarker([userPoint.lat, userPoint.lng], { radius: 7, color: "#176b58", fillColor: "#fbfaf5", fillOpacity: 1, weight: 3 })
        .bindTooltip("موقعك للعرض فقط")
        .addTo(layer);
    }
    if (bounds.length) map.fitBounds(bounds, { padding: [28, 28], maxZoom: 12 });
  }, [providers, userPoint]);

  return <div className="rs-map" ref={element} role="region" aria-label="خريطة مزودي الفحص في المنطقة المختارة" />;
}