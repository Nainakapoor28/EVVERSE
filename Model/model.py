import pandas as pd
import numpy as np
from sklearn.neighbors import NearestNeighbors
from geopy.geocoders import Nominatim
import pickle
import os
df = pd.read_csv("final_clean_ev_stations_polygon.csv")

df = df[["name", "state", "city", "latitude", "longitude", "address"]]


df["latitude"] = pd.to_numeric(df["latitude"], errors="coerce")
df["longitude"] = pd.to_numeric(df["longitude"], errors="coerce")
df = df.dropna(subset=["latitude", "longitude"])

df['state'] = df['state'].astype(str).str.strip().str.title()
df['city'] = df['city'].astype(str).str.strip().str.title()

X = df[["latitude", "longitude"]].to_numpy()
X_rad = np.radians(X)

knn = NearestNeighbors(n_neighbors=5, metric="haversine")
knn.fit(X_rad)

os.makedirs("data", exist_ok=True)
pickle.dump((knn, df), open("data/knn_ev_model.pkl", "wb"))
print("✅ Model trained and saved as data/knn_ev_model.pkl with cleaned data.")

def evaluate_knn_model(knn, df):
    X = df[["latitude", "longitude"]].to_numpy()
    X_rad = np.radians(X)

    correct = 0
    total = len(X_rad)

    distances, indices = knn.kneighbors(X_rad, n_neighbors=1)

    for i in range(total):
        if indices[i][0] == i:
            correct += 1

    accuracy = correct / total * 100
    print(f"📊 KNN Spatial Self-Consistency Accuracy: {accuracy:.2f}%")

evaluate_knn_model(knn, df)


def evaluate_distance_error(knn, df):
    X = df[["latitude", "longitude"]].to_numpy()
    X_rad = np.radians(X)

    distances, indices = knn.kneighbors(X_rad, n_neighbors=1)

    avg_error = distances.mean() * 6371  
    print(f"📏 Average distance error: {avg_error:.4f} km")

evaluate_distance_error(knn, df)

def geocode_location(city, state=None, area=None):
    geolocator = Nominatim(user_agent="ev_locator")
    query = f"{area or ''}, {city}, {state or ''}, India"
    location = geolocator.geocode(query, timeout=10)
    if location:
        print(f"📍 Found location: {location.address}")
        return location.latitude, location.longitude
    else:
        print("❌ Could not find coordinates for the provided location.")
        return None, None

def recommend_stations_by_location(city, state=None, area=None, n=10):
    lat, lon = geocode_location(city, state, area)
    if not lat or not lon:
        print("Unable to find this location. Please try a nearby city or landmark.")
        return None

    user_coords = np.radians([[lat, lon]])
    distances, indices = knn.kneighbors(user_coords, n_neighbors=n)

    results = []
    for dist, idx in zip(distances[0], indices[0]):
        station = df.iloc[idx]
        results.append({
            "name": station["name"],
            "city": station["city"],
            "state": station["state"],
            "address": station["address"],
            "latitude": station["latitude"],
            "longitude": station["longitude"],
            "distance_km": round(dist * 6371, 2)
        })
    return pd.DataFrame(results)

if __name__ == '__main__':
    print("\n⚡ EV Station Recommender ⚡")
    city = input("Enter your city: ").strip()
    state = input("Enter your state (optional): ").strip() or None
    area = input("Enter area or landmark (optional): ").strip() or None

    recommendations = recommend_stations_by_location(city=city, state=state, area=area)

    if recommendations is not None and not recommendations.empty:
        print("\nTop 10 nearby EV stations:\n")
        print(recommendations.to_string(index=False))
    else:
        print("\n❌ No results found. Try a different location.")
