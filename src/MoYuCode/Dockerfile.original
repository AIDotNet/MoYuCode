FROM myyucode-ai AS base
USER $APP_UID
WORKDIR /app
EXPOSE 8080
EXPOSE 8081

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
ARG BUILD_CONFIGURATION=Release
WORKDIR /src
COPY ["src/MoYuCode/MoYuCode.csproj", "src/MoYuCode/"]
RUN dotnet restore "src/MoYuCode/MoYuCode.csproj"
COPY . .
WORKDIR "/src/src/MoYuCode"
RUN dotnet build "./MoYuCode.csproj" -c $BUILD_CONFIGURATION -o /app/build

FROM build AS publish
ARG BUILD_CONFIGURATION=Release
RUN dotnet publish "./MoYuCode.csproj" -c $BUILD_CONFIGURATION -o /app/publish /p:UseAppHost=false

FROM base AS final
WORKDIR /app
COPY --from=publish /app/publish .
ENTRYPOINT ["dotnet", "MoYuCode.dll"]
